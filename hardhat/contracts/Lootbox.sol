// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IERC1155BurnableKeys {
    function burn(address account, uint256 id, uint256 value) external;
}

interface IMintableERC721 {
    function mint(address to) external returns (uint256 tokenId);
}

interface IRewardVaultERC721 {
    function remaining() external view returns (uint256);
    function dispense(address to) external returns (uint256 tokenId);
}

/// @notice Instant lootbox: burn key, draw, and award in one transaction.
/// @dev Randomness is on-chain only (not VRF). Probabilities follow remaining counts per bucket
///      (same mass model as `SomniaLootboxVRF`). Use `maxSuccessfulOpensPerUser_ = 0` for no per-user cap.
contract Lootbox is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant PRIZE_COUNT = 7;

    enum PrizeKind {
        NONE,
        ERC20,
        ERC721_VAULT,
        POINTS,
        ERC721,
        WHITELIST
    }

    struct PrizeConfig {
        uint32 remaining;
        PrizeKind kind;
        address token;
        uint256 id;
        uint256 amount;
    }

    event OpenRequested(address indexed user, uint256 requestId);
    event ItemAwarded(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount);
    event ItemClaimed(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount);
    event PointsAwarded(address indexed user, uint256 amount, uint256 newTotal);
    event SweptNative(address indexed to, uint256 amount);
    event SweptErc20(address indexed token, address indexed to, uint256 amount);

    IERC1155BurnableKeys public immutable keys;

    /// @notice Prize table. Item types are 0..PRIZE_COUNT-1.
    PrizeConfig[PRIZE_COUNT] public prizes;

    uint256 public nextRequestId;

    mapping(address => uint256) public points;
    mapping(address => bool) public whitelisted;

    mapping(address => mapping(address => uint256)) public claimableErc20;
    mapping(address => mapping(address => uint256)) public claimableErc721;
    mapping(address => uint256) public claimableNative;
    mapping(address => uint256) public reservedErc721;

    bool public configLocked;

    uint256 public successfulOpens;
    uint256 public immutable maxSuccessfulOpensPerUser;
    mapping(address => uint256) public userSuccessfulOpens;

    error SoldOut();
    error ConfigLockedErr();
    error NotLive();
    error MaxOpensReached();
    error BadPrizeConfig();
    error VaultUnavailable();

    constructor(address keys_, uint256 maxSuccessfulOpensPerUser_) Ownable(msg.sender) {
        require(keys_ != address(0), "KEYS_0");
        keys = IERC1155BurnableKeys(keys_);
        maxSuccessfulOpensPerUser = maxSuccessfulOpensPerUser_;
    }

    receive() external payable {}

    function setPrize(
        uint8 itemType,
        uint32 remaining,
        PrizeKind kind,
        address token,
        uint256 id,
        uint256 amount
    ) external onlyOwner {
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
            if (amount == 0) revert BadPrizeConfig();
        } else if (kind == PrizeKind.ERC721) {
            if (amount != 1) revert BadPrizeConfig();
        }

        prizes[itemType] = PrizeConfig({remaining: remaining, kind: kind, token: token, id: id, amount: amount});
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

    function effectiveRemainingTotal() external view returns (uint256) {
        return _effectiveRemainingTotal();
    }

    /// @notice Burn exactly 1 key; randomness is derived on-chain; prize is awarded in the same transaction.
    function openWithKey(uint256 keyId) external nonReentrant whenNotPaused {
        if (!configLocked) revert NotLive();
        if (maxSuccessfulOpensPerUser != 0 && userSuccessfulOpens[msg.sender] >= maxSuccessfulOpensPerUser) {
            revert MaxOpensReached();
        }

        uint256 effTotal = _effectiveRemainingTotal();
        if (effTotal == 0) revert SoldOut();

        keys.burn(msg.sender, keyId, 1);

        uint256 requestId = ++nextRequestId;
        emit OpenRequested(msg.sender, requestId);

        uint256 randomness = uint256(
            keccak256(abi.encodePacked(block.prevrandao, blockhash(block.number - 1), msg.sender, requestId, address(this)))
        );

        uint8 itemType = _pickPrize(randomness);
        _award(msg.sender, itemType);

        successfulOpens += 1;
        userSuccessfulOpens[msg.sender] += 1;
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

        if (p.kind == PrizeKind.ERC721) {
            claimableErc721[user][p.token] += 1;
            emit ItemAwarded(user, itemType, p.token, 0, 1);
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

        if (p.kind == PrizeKind.WHITELIST) {
            whitelisted[user] = true;
            emit ItemAwarded(user, itemType, address(0), 0, 1);
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
            total += _effectiveRemainingFor(prizes[i]);
        }
    }

    function claimErc20(address token) external nonReentrant whenNotPaused {
        uint256 amt = claimableErc20[msg.sender][token];
        require(amt > 0, "NOTHING");
        claimableErc20[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amt);
        emit ItemClaimed(msg.sender, 255, token, 0, amt);
    }

    function claimNative() external nonReentrant whenNotPaused {
        uint256 amt = claimableNative[msg.sender];
        require(amt > 0, "NOTHING");
        claimableNative[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok, "SEND_FAIL");
    }

    /// @notice Claim ERC721 mints (legacy `ERC721` prizes) or vault dispenses (`ERC721_VAULT` prizes).
    function claimErc721(address nftOrVault, uint256 maxCount) external nonReentrant whenNotPaused {
        uint256 count = claimableErc721[msg.sender][nftOrVault];
        require(count > 0, "NOTHING");
        if (maxCount == 0 || maxCount > count) maxCount = count;
        claimableErc721[msg.sender][nftOrVault] = count - maxCount;

        // Try vault dispense first (S5 / production path).
        bool isVault = false;
        try IRewardVaultERC721(nftOrVault).remaining() returns (uint256) {
            isVault = true;
        } catch {
            isVault = false;
        }

        if (isVault) {
            reservedErc721[nftOrVault] -= maxCount;
            for (uint256 i = 0; i < maxCount; i++) {
                uint256 tokenId = IRewardVaultERC721(nftOrVault).dispense(msg.sender);
                emit ItemClaimed(msg.sender, 255, nftOrVault, tokenId, 1);
            }
            return;
        }

        for (uint256 i = 0; i < maxCount; i++) {
            uint256 tokenId = IMintableERC721(nftOrVault).mint(msg.sender);
            emit ItemClaimed(msg.sender, 255, nftOrVault, tokenId, 1);
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

    /// @notice Admin-only recovery of leftover ERC20 balance.
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
