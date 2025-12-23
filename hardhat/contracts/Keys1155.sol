// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Testnet/Hardhat analogue of Odyssey Keys1155.
/// @dev Matches the relevant ABI surface: baseURI/signer, setBaseURI/setSigner, mintWithSig, minted(account,nonce), used(digest).
contract Keys1155 is ERC1155, Ownable, EIP712 {
    using Strings for uint256;

    // Same semantics as your artifact: minted(account, nonce) and used(digest).
    mapping(address => mapping(uint256 => bool)) public minted;
    mapping(bytes32 => bool) public used;

    string public baseURI;
    address public signer;

    event BaseURIUpdated(string newBaseURI);
    event SignerUpdated(address indexed signer_);

    bytes32 private constant MINT_TYPEHASH = keccak256(
        "Mint(address to,uint256 id,uint256 nonce,uint256 deadline)"
    );

    constructor(string memory _baseURI, address _signer) ERC1155("") Ownable(msg.sender) EIP712("SomniaKeys", "1") {
        baseURI = _baseURI;
        signer = _signer;
    }

    function uri(uint256 id) public view override returns (string memory) {
        // Keep it simple for tests.
        return string.concat(baseURI, id.toString());
    }

    function setBaseURI(string calldata u) external onlyOwner {
        baseURI = u;
        emit BaseURIUpdated(u);
    }

    function setSigner(address s) external onlyOwner {
        signer = s;
        emit SignerUpdated(s);
    }

    /// @notice Mint 1 key (id must be 1..8) authorized by an EIP-712 signature.
    function mintWithSig(
        address to,
        uint256 id,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, "DEADLINE");
        require(id >= 1 && id <= 8, "BAD_ID");
        require(!minted[to][nonce], "NONCE_USED");

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(MINT_TYPEHASH, to, id, nonce, deadline)));
        require(!used[digest], "SIG_USED");

        address recovered = ECDSA.recover(digest, signature);
        require(recovered == signer, "BAD_SIG");

        minted[to][nonce] = true;
        used[digest] = true;

        _mint(to, id, 1, "");
    }
}


