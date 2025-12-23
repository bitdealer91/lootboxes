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

/// @notice Lootbox with on-chain weighted selection and strict supply caps.
/// @dev RNG must be verifiable (VRF) in production. Tests use a mock RNG caller.
contract Lootbox is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum PrizeKind {
        NONE,
        ERC20,
        ERC721,
        POINTS,
        WHITELIST
    }

    struct PrizeConfig {
        // Weight is an integer; relative weights define probabilities.
        uint32 weight;
        // Remaining count for this prize.
        uint32 remaining;
        PrizeKind kind;
        address token;
        // For ERC20: ignored. For POINTS/WHITELIST: ignored.
        // For ERC721: ignored (tokenId determined at mint).
        uint256 id;
        // For ERC20: transfer amount. For POINTS: points amount.
        // For ERC721/WHITELIST: should be 1.
        uint256 amount;
    }

    event OpenRequested(address indexed user, uint256 requestId);
    /// @notice Award has been determined on-chain (may be claimable for token/NFT).
    event ItemAwarded(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount);
    /// @notice User has claimed a previously awarded item (for ERC20 / ERC721).
    event ItemClaimed(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount);

    IERC1155BurnableKeys public immutable keys;

    /// @dev Only this address can fulfill randomness (VRF coordinator / oracle).
    address public rngProvider;

    /// @dev 0..4 item types. Keep in sync with the frontend mapping.
    PrizeConfig[5] public prizes;

    /// @dev Total prizes remaining across all item types.
    uint256 public remainingTotal;

    uint256 public nextRequestId;
    mapping(uint256 => address) public requestUser;
    mapping(address => bool) public userHasPending;

    mapping(address => uint256) public points;
    mapping(address => bool) public whitelisted;

    // Claimable rewards (fulfill does NOT make external calls, so it can't get stuck)
    mapping(address => mapping(address => uint256)) public claimableErc20; // user => token => amount
    mapping(address => mapping(address => uint256)) public claimableErc721; // user => nft => count

    bool public configLocked;

    error NotRngProvider();
    error BadRequest();
    error PendingRequest();
    error SoldOut();
    error ConfigLockedErr();

    constructor(address keys_, address rngProvider_) Ownable(msg.sender) {
        require(keys_ != address(0), "KEYS_0");
        keys = IERC1155BurnableKeys(keys_);
        rngProvider = rngProvider_;
    }

    function setRngProvider(address rngProvider_) external onlyOwner {
        if (configLocked) revert ConfigLockedErr();
        rngProvider = rngProvider_;
    }

    function setPrize(
        uint8 itemType,
        uint32 weight,
        uint32 remaining,
        PrizeKind kind,
        address token,
        uint256 id,
        uint256 amount
    ) external onlyOwner {
        if (configLocked) revert ConfigLockedErr();
        require(itemType < 5, "BAD_ITEM");

        // Update remainingTotal accounting.
        uint32 prev = prizes[itemType].remaining;
        if (remaining >= prev) {
            remainingTotal += uint256(remaining - prev);
        } else {
            remainingTotal -= uint256(prev - remaining);
        }

        prizes[itemType] = PrizeConfig({
            weight: weight,
            remaining: remaining,
            kind: kind,
            token: token,
            id: id,
            amount: amount
        });
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

    /// @notice Burn exactly 1 key and request an opening.
    function openWithKey(uint256 keyId) external nonReentrant whenNotPaused {
        if (userHasPending[msg.sender]) revert PendingRequest();
        if (remainingTotal == 0) revert SoldOut();

        // Reserve one prize slot so the user can never burn a key and get stuck
        // due to global sold-out between request and fulfill.
        remainingTotal -= 1;

        keys.burn(msg.sender, keyId, 1);

        uint256 requestId = ++nextRequestId;
        requestUser[requestId] = msg.sender;
        userHasPending[msg.sender] = true;

        emit OpenRequested(msg.sender, requestId);
    }

    /// @notice Fulfill a request using verifiable randomness.
    function fulfillRandomness(uint256 requestId, uint256 randomness) external nonReentrant {
        if (msg.sender != rngProvider) revert NotRngProvider();

        address user = requestUser[requestId];
        if (user == address(0)) revert BadRequest();

        delete requestUser[requestId];
        userHasPending[user] = false;

        uint8 itemType = _pickPrize(randomness);
        _award(user, itemType);
    }

    function _pickPrize(uint256 randomness) internal returns (uint8 itemType) {
        // totalWeight from prizes with remaining > 0
        uint256 totalWeight;
        for (uint8 i = 0; i < 5; i++) {
            if (prizes[i].remaining > 0) totalWeight += prizes[i].weight;
        }

        // remainingTotal was reserved on openWithKey, so this should never be 0
        // unless misconfigured.
        if (totalWeight == 0) revert SoldOut();

        uint256 r = randomness % totalWeight;
        for (uint8 i = 0; i < 5; i++) {
            PrizeConfig storage p = prizes[i];
            if (p.remaining == 0) continue;

            uint256 w = p.weight;
            if (r < w) {
                p.remaining -= 1;
                return i;
            }
            r -= w;
        }

        // Should be unreachable.
        return 4;
    }

    function _award(address user, uint8 itemType) internal {
        PrizeConfig storage p = prizes[itemType];

        if (p.kind == PrizeKind.ERC20) {
            // Record as claimable to avoid any chance of fulfill getting stuck
            // due to token transfer failure (e.g. temporary underfunding).
            claimableErc20[user][p.token] += p.amount;
            emit ItemAwarded(user, itemType, p.token, 0, p.amount);
            return;
        }

        if (p.kind == PrizeKind.ERC721) {
            // Record as claimable. Mint happens on claim.
            claimableErc721[user][p.token] += 1;
            emit ItemAwarded(user, itemType, p.token, 0, 1);
            return;
        }

        if (p.kind == PrizeKind.POINTS) {
            points[user] += p.amount;
            emit ItemAwarded(user, itemType, address(0), 0, p.amount);
            return;
        }

        if (p.kind == PrizeKind.WHITELIST) {
            whitelisted[user] = true;
            emit ItemAwarded(user, itemType, address(0), 0, 1);
            return;
        }

        // NONE
        emit ItemAwarded(user, itemType, address(0), 0, p.amount);
    }

    /// @notice Claim ERC20 rewards for a specific token.
    function claimErc20(address token) external nonReentrant whenNotPaused {
        uint256 amt = claimableErc20[msg.sender][token];
        require(amt > 0, "NOTHING");
        claimableErc20[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amt);
        emit ItemClaimed(msg.sender, 255, token, 0, amt);
    }

    /// @notice Claim up to `maxCount` ERC721 mints for a specific NFT contract.
    function claimErc721(address nft, uint256 maxCount) external nonReentrant whenNotPaused {
        uint256 count = claimableErc721[msg.sender][nft];
        require(count > 0, "NOTHING");
        if (maxCount == 0 || maxCount > count) maxCount = count;
        claimableErc721[msg.sender][nft] = count - maxCount;

        for (uint256 i = 0; i < maxCount; i++) {
            uint256 tokenId = IMintableERC721(nft).mint(msg.sender);
            emit ItemClaimed(msg.sender, 255, nft, tokenId, 1);
        }
    }
}



