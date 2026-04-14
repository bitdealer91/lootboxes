// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice Simple ERC721 escrow vault with a FIFO queue.
/// @dev Deposit NFTs into the vault; lootbox dispenses sequentially to winners.
contract RewardVaultERC721 is Ownable, IERC721Receiver {
    IERC721 public immutable nft;

    address public lootbox;
    bool public lootboxLocked;

    uint256[] public queue;
    uint256 public cursor;
    /// @dev Tracks tokenIds that are currently in the queue (not yet dispensed/withdrawn).
    mapping(uint256 => bool) public inQueue;

    error NotLootbox();
    error Empty();
    error AlreadyQueued();
    error NotUntracked();
    error LootboxLocked();
    error LootboxUnset();

    event LootboxSet(address indexed lootbox);
    event LootboxLockedEvent();
    event Deposited(address indexed from, uint256 indexed tokenId);
    event Dispensed(address indexed to, uint256 indexed tokenId);
    event Withdrawn(address indexed to, uint256 indexed tokenId);

    constructor(address nft_) Ownable(msg.sender) {
        require(nft_ != address(0), "NFT_0");
        nft = IERC721(nft_);
    }

    /// @notice Wire the lootbox that may call `dispense`. Callable until `lockLootbox()`.
    function setLootbox(address lootbox_) external onlyOwner {
        require(lootbox_ != address(0), "LB_0");
        if (lootboxLocked) revert LootboxLocked();
        lootbox = lootbox_;
        emit LootboxSet(lootbox_);
    }

    /// @notice Permanently prevent changing `lootbox` (recommended after mainnet wiring).
    function lockLootbox() external onlyOwner {
        if (lootbox == address(0)) revert LootboxUnset();
        lootboxLocked = true;
        emit LootboxLockedEvent();
    }

    /// @notice Deposit specific tokenIds into the vault.
    /// @dev Sender must own the tokens and approve this vault.
    function deposit(uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (inQueue[tokenId]) revert AlreadyQueued();
            nft.safeTransferFrom(msg.sender, address(this), tokenId);
            queue.push(tokenId);
            inQueue[tokenId] = true;
            emit Deposited(msg.sender, tokenId);
        }
    }

    function remaining() external view returns (uint256) {
        return queue.length - cursor;
    }

    /// @notice Admin-only recovery of leftover NFTs (not yet dispensed).
    /// @dev Moves up to `maxCount` NFTs from the remaining queue to `to` and advances the cursor,
    ///      so future `dispense()` continues to work.
    function withdrawRemaining(address to, uint256 maxCount) external onlyOwner {
        require(to != address(0), "TO_0");
        uint256 left = queue.length - cursor;
        if (maxCount == 0 || maxCount > left) maxCount = left;
        for (uint256 i = 0; i < maxCount; i++) {
            uint256 tokenId = queue[cursor++];
            inQueue[tokenId] = false;
            nft.safeTransferFrom(address(this), to, tokenId);
            emit Withdrawn(to, tokenId);
        }
    }

    /// @notice Admin-only rescue for NFTs that were transferred to this vault directly (not via `deposit()`).
    /// @dev These tokenIds are not in the queue, so they would otherwise be stuck from the reward flow.
    function rescueUntracked(address to, uint256 tokenId) external onlyOwner {
        require(to != address(0), "TO_0");
        if (inQueue[tokenId]) revert NotUntracked();
        require(nft.ownerOf(tokenId) == address(this), "NOT_OWNED");
        nft.safeTransferFrom(address(this), to, tokenId);
    }

    /// @notice Dispense next NFT to winner. Only lootbox can call.
    function dispense(address to) external returns (uint256 tokenId) {
        if (msg.sender != lootbox) revert NotLootbox();
        if (cursor >= queue.length) revert Empty();
        tokenId = queue[cursor++];
        inQueue[tokenId] = false;
        nft.safeTransferFrom(address(this), to, tokenId);
        emit Dispensed(to, tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
