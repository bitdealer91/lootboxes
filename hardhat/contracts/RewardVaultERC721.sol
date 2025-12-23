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

    uint256[] public queue;
    uint256 public cursor;

    error NotLootbox();
    error Empty();

    event LootboxSet(address indexed lootbox);
    event Deposited(address indexed from, uint256 indexed tokenId);
    event Dispensed(address indexed to, uint256 indexed tokenId);

    constructor(address nft_) Ownable(msg.sender) {
        require(nft_ != address(0), "NFT_0");
        nft = IERC721(nft_);
    }

    function setLootbox(address lootbox_) external onlyOwner {
        lootbox = lootbox_;
        emit LootboxSet(lootbox_);
    }

    /// @notice Deposit specific tokenIds into the vault.
    /// @dev Sender must own the tokens and approve this vault.
    function deposit(uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            nft.safeTransferFrom(msg.sender, address(this), tokenId);
            queue.push(tokenId);
            emit Deposited(msg.sender, tokenId);
        }
    }

    function remaining() external view returns (uint256) {
        return queue.length - cursor;
    }

    /// @notice Dispense next NFT to winner. Only lootbox can call.
    function dispense(address to) external returns (uint256 tokenId) {
        if (msg.sender != lootbox) revert NotLootbox();
        if (cursor >= queue.length) revert Empty();
        tokenId = queue[cursor++];
        nft.safeTransferFrom(address(this), to, tokenId);
        emit Dispensed(to, tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return this.onERC721Received.selector;
    }
}


