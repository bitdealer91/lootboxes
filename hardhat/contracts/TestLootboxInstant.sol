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

/// @dev Vault that holds ERC721s and dispenses sequentially.
interface IRewardVaultERC721 {
    function dispense(address to) external returns (uint256 tokenId);
}

/// @notice Testnet-only lootbox with immediate on-chain randomness.
/// @dev INSECURE RNG (block-based). Use only for UI testing.
///
/// Loot table is "always win": each open consumes exactly 1 from a finite prize pool.
/// Probability is proportional to remaining counts.
contract TestLootboxInstant is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum PrizeKind {
        NONE,
        /// @dev Use native token by setting token=address(0); otherwise ERC20.
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
    event ItemAwarded(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount);
    event PointsAwarded(address indexed user, uint256 amount, uint256 newTotal);
    event SweptNative(address indexed to, uint256 amount);
    event SweptErc20(address indexed token, address indexed to, uint256 amount);

    IERC1155BurnableKeys public immutable keys;

    uint8 public constant PRIZE_COUNT = 10;

    /// @notice Prize table. Item types are 0..9.
    PrizeConfig[PRIZE_COUNT] public prizes;

    /// @notice Remaining items across all prizes.
    uint256 public remainingTotal;

    bool public configLocked;
    uint256 public nextRequestId;

    mapping(address => mapping(address => uint256)) public claimableErc20;
    mapping(address => mapping(address => uint256)) public claimableErc721;
    mapping(address => uint256) public claimableNative;
    mapping(address => uint256) public points;

    error SoldOut();
    error ConfigLockedErr();

    constructor(address keys_) Ownable(msg.sender) {
        require(keys_ != address(0), "KEYS_0");
        keys = IERC1155BurnableKeys(keys_);
    }

    receive() external payable {}

    function setPrize(uint8 itemType, uint32 remaining, PrizeKind kind, address token, uint256 amount) external onlyOwner {
        if (configLocked) revert ConfigLockedErr();
        require(itemType < PRIZE_COUNT, "BAD_ITEM");

        uint32 prev = prizes[itemType].remaining;
        if (remaining >= prev) remainingTotal += uint256(remaining - prev);
        else remainingTotal -= uint256(prev - remaining);

        prizes[itemType] = PrizeConfig({remaining: remaining, kind: kind, token: token, amount: amount});
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

    function openWithKey(uint256 keyId) external nonReentrant whenNotPaused {
        if (remainingTotal == 0) revert SoldOut();

        // burn one lootbox key
        keys.burn(msg.sender, keyId, 1);

        uint256 requestId = ++nextRequestId;
        emit OpenRequested(msg.sender, requestId);

        // INSECURE randomness for testnet only
        uint256 randomness =
            uint256(keccak256(abi.encodePacked(block.prevrandao, blockhash(block.number - 1), msg.sender, requestId)));

        uint8 itemType = _pickPrize(randomness);
        _award(msg.sender, itemType);
    }

    function _pickPrize(uint256 randomness) internal returns (uint8 itemType) {
        if (remainingTotal == 0) revert SoldOut();
        uint256 r = randomness % remainingTotal;

        for (uint256 i = 0; i < PRIZE_COUNT; i++) {
            PrizeConfig storage p = prizes[i];
            if (p.remaining == 0) continue;

            uint256 m = uint256(p.remaining);
            if (r < m) {
                p.remaining -= 1;
                remainingTotal -= 1;
                return uint8(i);
            }
            r -= m;
        }

        revert SoldOut();
    }

    function _award(address user, uint8 itemType) internal {
        PrizeConfig storage p = prizes[itemType];

        if (p.kind == PrizeKind.ERC20) {
            // Use native token by setting token=address(0)
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
            claimableErc721[user][p.token] += 1;
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



