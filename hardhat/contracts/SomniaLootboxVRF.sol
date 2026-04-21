// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {VRFV2PlusWrapperConsumerBase} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFV2PlusWrapperConsumerBase.sol";

/// @dev Lootbox key: burn on open, mint back on emergency VRF recovery.
interface ILootboxKeyForLootbox {
    function burn(address account, uint256 id, uint256 value) external;
    function mint(address to, uint256 id, uint256 amount) external;
}

/// @dev Vault that holds ERC721s and dispenses sequentially.
interface IRewardVaultERC721 {
    function remaining() external view returns (uint256);
    function dispense(address to) external returns (uint256 tokenId);
}

/// @notice Production lootbox using Chainlink VRF v2.5 (via wrapper) on Somnia.
/// @dev Minimal-UI-change design: `openWithKey()` emits `OpenRequested`; `ItemAwarded` is emitted later in VRF callback.
contract SomniaLootboxVRF is Ownable, Pausable, ReentrancyGuard, VRFV2PlusWrapperConsumerBase {
    using SafeERC20 for IERC20;

    enum PrizeKind {
        NONE,
        /// @dev Use native token by setting token=address(0); otherwise ERC20. Disabled in production unless `erc20NativePrizesEnabled`.
        ERC20,
        /// @dev token is a RewardVaultERC721
        ERC721_VAULT,
        POINTS
    }

    struct PrizeConfig {
        uint32 remaining;
        PrizeKind kind;
        address token;
        uint256 amount;
    }

    event OpenRequested(address indexed user, uint256 requestId);
    event RandomnessRequested(uint256 indexed requestId, address indexed user, uint256 paid);
    event ItemAwarded(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount);
    event PointsAwarded(address indexed user, uint256 amount, uint256 newTotal);
    event SweptNative(address indexed to, uint256 amount);
    event SweptErc20(address indexed token, address indexed to, uint256 amount);
    /// @notice Key was re-minted to `user` after VRF did not fulfill before `vrfRecoveryTimeoutSeconds`.
    event VrfRequestRecovered(uint256 indexed requestId, address indexed user, uint256 keyId, address indexed caller);

    ILootboxKeyForLootbox public immutable keys;

    uint8 public constant PRIZE_COUNT = 7;
    uint32 public constant NUM_WORDS = 1;

    /// @notice Prize table. Item types are 0..6.
    PrizeConfig[PRIZE_COUNT] public prizes;

    /// @notice Remaining items across all prizes.
    uint256 public remainingTotal;

    bool public configLocked;

    /// @notice When false, `PrizeKind.ERC20` cannot be configured (native/ERC20 claim path stays off for production).
    bool public erc20NativePrizesEnabled;

    /// @notice VRF wrapper parameters (affects request fee).
    uint32 public callbackGasLimit;
    uint16 public requestConfirmations;

    /// @notice After this many seconds, an owner or the user may recover a stuck VRF request and return the burnt key.
    uint256 public vrfRecoveryTimeoutSeconds;

    /// @dev Request tracking
    mapping(uint256 => address) public requestUser;
    mapping(address => bool) public userHasPending;
    uint256 public pendingRequests;
    mapping(uint256 => uint256) public requestCreatedAt;
    mapping(uint256 => uint256) public requestKeyId;
    mapping(address => uint256) public userPendingRequestId;

    /// @notice Claimables + state
    mapping(address => mapping(address => uint256)) public claimableErc20;
    mapping(address => mapping(address => uint256)) public claimableErc721;
    mapping(address => uint256) public claimableNative;
    mapping(address => uint256) public points;
    /// @dev Outstanding, not-yet-claimed ERC721 awards per vault.
    mapping(address => uint256) public reservedErc721;

    error SoldOut();
    error ConfigLockedErr();
    error PendingRequest();
    error BadRequest();
    error NotLive();
    error InsufficientVrfBalance(uint256 required, uint256 current);
    error VaultUnavailable();
    error BadPrizeConfig();
    error Erc20PrizesDisabled();
    error RecoveryTooEarly();
    error RecoveryNotPending();
    error MaxOpensReached();

    /// @notice Successful VRF fulfillments that awarded a prize (0 = unlimited).
    uint256 public successfulOpens;

    /// @notice Max successful opens for this lootbox instance (0 = unlimited).
    uint256 public immutable maxSuccessfulOpens;

    constructor(
        address keys_,
        address vrfWrapper_,
        uint32 callbackGasLimit_,
        uint16 requestConfirmations_,
        uint256 maxSuccessfulOpens_
    )
        Ownable(msg.sender)
        VRFV2PlusWrapperConsumerBase(vrfWrapper_)
    {
        require(keys_ != address(0), "KEYS_0");
        keys = ILootboxKeyForLootbox(keys_);
        callbackGasLimit = callbackGasLimit_;
        requestConfirmations = requestConfirmations_;
        vrfRecoveryTimeoutSeconds = 1 days;
        maxSuccessfulOpens = maxSuccessfulOpens_;
    }

    receive() external payable {}

    function setErc20NativePrizesEnabled(bool on) external onlyOwner {
        if (configLocked) revert ConfigLockedErr();
        erc20NativePrizesEnabled = on;
    }

    function setVrfRecoveryTimeoutSeconds(uint256 seconds_) external onlyOwner {
        if (configLocked) revert ConfigLockedErr();
        require(seconds_ >= 1 hours && seconds_ <= 30 days, "BAD_TIMEOUT");
        vrfRecoveryTimeoutSeconds = seconds_;
    }

    function setPrize(uint8 itemType, uint32 remaining, PrizeKind kind, address token, uint256 amount) external onlyOwner {
        if (configLocked) revert ConfigLockedErr();
        require(itemType < PRIZE_COUNT, "BAD_ITEM");

        if (kind == PrizeKind.NONE) {
            if (remaining > 0) revert BadPrizeConfig();
        } else if (kind == PrizeKind.ERC721_VAULT) {
            if (token == address(0)) revert BadPrizeConfig();
            if (amount != 1) revert BadPrizeConfig();
        } else if (kind == PrizeKind.POINTS) {
            if (amount == 0) revert BadPrizeConfig();
        } else if (kind == PrizeKind.ERC20) {
            if (!erc20NativePrizesEnabled) revert Erc20PrizesDisabled();
            if (amount == 0) revert BadPrizeConfig();
        }

        uint32 prev = prizes[itemType].remaining;
        if (remaining >= prev) remainingTotal += uint256(remaining - prev);
        else remainingTotal -= uint256(prev - remaining);

        prizes[itemType] = PrizeConfig({remaining: remaining, kind: kind, token: token, amount: amount});
    }

    function setVrfConfig(uint32 callbackGasLimit_, uint16 requestConfirmations_) external onlyOwner {
        if (configLocked) revert ConfigLockedErr();
        callbackGasLimit = callbackGasLimit_;
        requestConfirmations = requestConfirmations_;
    }

    function lockConfig() external onlyOwner {
        configLocked = true;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice On-chain view of effective remaining draw weight (caps ERC721 buckets by vault stock).
    function effectiveRemainingTotal() external view returns (uint256) {
        return _effectiveRemainingTotal();
    }

    /// @notice Pending VRF request for `user`, if any.
    function getPendingRequest(address user)
        external
        view
        returns (bool pending, uint256 requestId, uint256 keyId, uint256 createdAt, bool recoveryEligible)
    {
        pending = userHasPending[user];
        if (!pending) return (false, 0, 0, 0, false);
        requestId = userPendingRequestId[user];
        keyId = requestKeyId[requestId];
        createdAt = requestCreatedAt[requestId];
        recoveryEligible = block.timestamp >= createdAt + vrfRecoveryTimeoutSeconds;
    }

    /// @notice Current VRF fee (in native chain token; SOMI on Somnia mainnet) for one request.
    function getVrfRequestPrice() public view returns (uint256) {
        return i_vrfV2PlusWrapper.calculateRequestPriceNative(callbackGasLimit, NUM_WORDS);
    }

    /// @notice Burn exactly 1 lootbox key and request opening randomness.
    /// @dev The contract must have enough native token (SOMI on mainnet) to pay VRF wrapper fees.
    function openWithKey(uint256 keyId) external nonReentrant whenNotPaused {
        if (!configLocked) revert NotLive();
        if (userHasPending[msg.sender]) revert PendingRequest();
        uint256 effTotal = _effectiveRemainingTotal();
        if (effTotal == 0) revert SoldOut();

        if (maxSuccessfulOpens != 0 && successfulOpens + pendingRequests >= maxSuccessfulOpens) {
            revert MaxOpensReached();
        }

        // Prevent oversubscription: keep one prize slot per pending request.
        if (effTotal <= pendingRequests) revert SoldOut();

        uint256 price = getVrfRequestPrice();
        uint256 bal = address(this).balance;
        if (bal < price) revert InsufficientVrfBalance(price, bal);

        keys.burn(msg.sender, keyId, 1);

        userHasPending[msg.sender] = true;
        pendingRequests += 1;

        VRFV2PlusClient.ExtraArgsV1 memory extraArgs = VRFV2PlusClient.ExtraArgsV1({nativePayment: true});
        bytes memory args = VRFV2PlusClient._argsToBytes(extraArgs);

        (uint256 requestId, uint256 paid) = this._requestVrf{value: price}(args);

        requestUser[requestId] = msg.sender;
        requestCreatedAt[requestId] = block.timestamp;
        requestKeyId[requestId] = keyId;
        userPendingRequestId[msg.sender] = requestId;

        emit OpenRequested(msg.sender, requestId);
        emit RandomnessRequested(requestId, msg.sender, paid);
    }

    /// @dev External self-call wrapper so we can attach `msg.value` from the contract balance.
    function _requestVrf(bytes calldata args) external payable returns (uint256 requestId, uint256 paid) {
        require(msg.sender == address(this), "ONLY_SELF");
        return requestRandomnessPayInNative(callbackGasLimit, requestConfirmations, NUM_WORDS, args);
    }

    /// @notice If VRF never fulfilled, return the user's key after `vrfRecoveryTimeoutSeconds`. Callable by the user.
    function recoverMyStuckVrfRequest() external nonReentrant {
        if (!userHasPending[msg.sender]) revert RecoveryNotPending();
        uint256 requestId = userPendingRequestId[msg.sender];
        _recoverVrfRequest(requestId, msg.sender, msg.sender);
    }

    /// @notice Same as user recovery but `onlyOwner` may pass any `requestId` (support / ops).
    function recoverStuckVrfRequest(uint256 requestId) external nonReentrant onlyOwner {
        address user = requestUser[requestId];
        if (user == address(0)) revert RecoveryNotPending();
        _recoverVrfRequest(requestId, user, msg.sender);
    }

    function _recoverVrfRequest(uint256 requestId, address user, address caller) internal {
        if (requestUser[requestId] != user) revert BadRequest();
        uint256 created = requestCreatedAt[requestId];
        if (created == 0) revert RecoveryNotPending();
        if (block.timestamp < created + vrfRecoveryTimeoutSeconds) revert RecoveryTooEarly();

        uint256 keyId = requestKeyId[requestId];

        delete requestUser[requestId];
        delete requestCreatedAt[requestId];
        delete requestKeyId[requestId];
        delete userPendingRequestId[user];
        userHasPending[user] = false;
        pendingRequests -= 1;

        keys.mint(user, keyId, 1);

        emit VrfRequestRecovered(requestId, user, keyId, caller);
    }

    /// @dev VRF wrapper callback.
    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override nonReentrant {
        address user = requestUser[requestId];
        if (user == address(0)) revert BadRequest();
        if (randomWords.length == 0) revert BadRequest();

        delete requestUser[requestId];
        delete requestCreatedAt[requestId];
        delete requestKeyId[requestId];
        delete userPendingRequestId[user];
        userHasPending[user] = false;
        pendingRequests -= 1;

        uint8 itemType = _pickPrize(randomWords[0]);
        _award(user, itemType);
        if (maxSuccessfulOpens != 0) {
            successfulOpens += 1;
        }
    }

    function _pickPrize(uint256 randomness) internal returns (uint8 itemType) {
        uint256 effTotal = _effectiveRemainingTotal();
        if (effTotal == 0) revert SoldOut();
        uint256 r = randomness % effTotal;

        for (uint256 i = 0; i < PRIZE_COUNT; i++) {
            PrizeConfig storage p = prizes[i];
            uint256 m = _effectiveRemainingFor(p);
            if (m == 0) continue;
            if (r < m) {
                p.remaining -= 1;
                return uint8(i);
            }
            r -= m;
        }

        revert SoldOut();
    }

    function _award(address user, uint8 itemType) internal {
        PrizeConfig storage p = prizes[itemType];

        if (p.kind == PrizeKind.ERC20) {
            if (p.token == address(0)) {
                claimableNative[user] += p.amount;
                emit ItemAwarded(user, itemType, address(0), 0, p.amount);
            } else {
                claimableErc20[user][p.token] += p.amount;
                emit ItemAwarded(user, itemType, p.token, 0, p.amount);
            }
            return;
        }

        if (p.kind == PrizeKind.ERC721_VAULT) {
            uint256 avail = _vaultAvailable(p.token);
            if (avail == 0) revert VaultUnavailable();
            claimableErc721[user][p.token] += 1;
            reservedErc721[p.token] += 1;
            emit ItemAwarded(user, itemType, p.token, 0, 1);
            return;
        }

        if (p.kind == PrizeKind.POINTS) {
            points[user] += p.amount;
            emit ItemAwarded(user, itemType, address(0), 0, p.amount);
            emit PointsAwarded(user, p.amount, points[user]);
            return;
        }

        emit ItemAwarded(user, itemType, address(0), 0, p.amount);
    }

    function _vaultAvailable(address vault) internal view returns (uint256) {
        uint256 rem = IRewardVaultERC721(vault).remaining();
        uint256 res = reservedErc721[vault];
        return rem > res ? (rem - res) : 0;
    }

    function _effectiveRemainingFor(PrizeConfig storage p) internal view returns (uint256) {
        if (p.remaining == 0) return 0;
        if (p.kind == PrizeKind.ERC721_VAULT) {
            uint256 avail = _vaultAvailable(p.token);
            uint256 cap = uint256(p.remaining);
            return avail < cap ? avail : cap;
        }
        return uint256(p.remaining);
    }

    function _effectiveRemainingTotal() internal view returns (uint256 total) {
        for (uint256 i = 0; i < PRIZE_COUNT; i++) {
            PrizeConfig storage p = prizes[i];
            total += _effectiveRemainingFor(p);
        }
    }

    function claimErc20(address token) external nonReentrant whenNotPaused {
        uint256 amt = claimableErc20[msg.sender][token];
        require(amt > 0, "NOTHING");
        claimableErc20[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amt);
    }

    function claimNative() external nonReentrant whenNotPaused {
        uint256 amt = claimableNative[msg.sender];
        require(amt > 0, "NOTHING");
        claimableNative[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok, "SEND_FAIL");
    }

    function claimErc721(address nftVault, uint256 maxCount) external nonReentrant whenNotPaused {
        uint256 count = claimableErc721[msg.sender][nftVault];
        require(count > 0, "NOTHING");
        if (maxCount == 0 || maxCount > count) maxCount = count;
        claimableErc721[msg.sender][nftVault] = count - maxCount;
        reservedErc721[nftVault] -= maxCount;
        for (uint256 i = 0; i < maxCount; i++) {
            IRewardVaultERC721(nftVault).dispense(msg.sender);
        }
    }

    /// @notice Admin-only recovery of leftover native balance.
    /// @dev Restricted to paused state to avoid surprise withdrawals during operation.
    function sweepNative(address payable to, uint256 amount) external onlyOwner nonReentrant whenPaused {
        require(to != address(0), "TO_0");
        uint256 bal = address(this).balance;
        if (amount == 0) amount = bal;
        require(amount <= bal, "INSUFFICIENT");
        (bool ok,) = to.call{value: amount}("");
        require(ok, "SEND_FAIL");
        emit SweptNative(to, amount);
    }

    /// @notice Admin-only recovery of leftover ERC20 balance (if ever used).
    /// @dev Restricted to paused state to avoid surprise withdrawals during operation.
    function sweepErc20(address token, address to, uint256 amount) external onlyOwner nonReentrant whenPaused {
        require(token != address(0), "TOKEN_0");
        require(to != address(0), "TO_0");
        IERC20 erc20 = IERC20(token);
        uint256 bal = erc20.balanceOf(address(this));
        if (amount == 0) amount = bal;
        require(amount <= bal, "INSUFFICIENT");
        erc20.safeTransfer(to, amount);
        emit SweptErc20(token, to, amount);
    }
}
