// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Burnable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice ERC1155 lootbox key token minted by the Mixer.
/// @dev The Mixer address must be set via `setMixer`. Mints from that address are capped per id (`MAX_MIXER_MINTS`);
///      other minters (e.g. lootbox VRF recovery) are not subject to this cap.
contract LootboxKey is ERC1155, ERC1155Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Max lifetime mints from the Mixer per token id (Odyssey → LootboxKey recipe).
    uint256 public constant MAX_MIXER_MINTS = 2;

    /// @notice Mixer contract allowed to mint up to `MAX_MIXER_MINTS` per `id`.
    address public mixer;

    /// @notice Cumulative amount minted by `mixer` per token id.
    mapping(uint256 => uint256) public mintedByMixer;

    constructor(string memory uri_) ERC1155(uri_) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function setMixer(address mixer_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        mixer = mixer_;
    }

    function mint(address to, uint256 id, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (msg.sender == mixer) {
            require(mixer != address(0), "MIXER_0");
            require(mintedByMixer[id] + amount <= MAX_MIXER_MINTS, "MIXER_CAP");
            mintedByMixer[id] += amount;
        }
        _mint(to, id, amount, "");
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}


