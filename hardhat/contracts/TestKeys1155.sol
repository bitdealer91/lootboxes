// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet-only faucet ERC1155 keys (ids 1..8).
/// @dev DO NOT use in production.
contract TestKeys1155 is ERC1155, Ownable {
    mapping(address => uint256) public mintedTotal;

    uint256 public constant MAX_PER_ADDRESS = 5000;

    constructor(string memory uri_) ERC1155(uri_) Ownable(msg.sender) {}

    function mintBatchTo(address to, uint256[] calldata ids, uint256[] calldata amounts) external {
        require(ids.length == amounts.length && ids.length > 0, "BAD_ARRAY");

        uint256 add;
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            require(id >= 1 && id <= 8, "BAD_ID");
            add += amounts[i];
        }

        uint256 next = mintedTotal[to] + add;
        require(next <= MAX_PER_ADDRESS, "CAP");
        mintedTotal[to] = next;

        _mintBatch(to, ids, amounts, "");
    }
}


