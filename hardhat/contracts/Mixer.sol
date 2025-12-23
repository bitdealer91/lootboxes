// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IERC1155Burnable {
    function burn(address account, uint256 id, uint256 value) external;
    function burnBatch(address account, uint256[] calldata ids, uint256[] calldata values) external;
}

interface ILootboxKeyMinter {
    function mint(address to, uint256 id, uint256 amount) external;
}

/// @notice Universal NFT mixer: swap configured NFT inputs into lootbox keys.
/// @dev Core idea: recipes are immutable rules; user supplies inputs; contract burns or escrows inputs, then mints output.
contract Mixer is Ownable, Pausable, ReentrancyGuard, IERC1155Receiver, IERC721Receiver {
    enum TokenType {
        ERC1155,
        ERC721
    }

    enum ConsumeMode {
        ESCROW,
        BURN
    }

    struct Recipe {
        TokenType tokenType;
        address inputToken;
        // For ERC1155: accept ids in [minId..maxId]. For ERC721: ignored.
        uint256 minId;
        uint256 maxId;
        // How many NFTs are required in total (sum of amounts or tokenIds length).
        uint256 requiredTotal;
        ConsumeMode mode;
        /// @dev For ESCROW mode: where inputs are sent (e.g. burn/sink EOA, or this contract).
        /// For BURN mode: ignored.
        address consumeTo;
        // Output (lootbox key)
        address outputKey;
        uint256 outputKeyId;
        uint256 outputAmount;
        bool enabled;
    }

    event RecipeSet(uint256 indexed recipeId, Recipe recipe);
    event RecipeFrozen(uint256 indexed recipeId);
    event Mixed(
        uint256 indexed recipeId,
        address indexed user,
        address indexed inputToken,
        uint256 requiredTotal,
        address outputKey,
        uint256 outputKeyId,
        uint256 outputAmount
    );

    mapping(uint256 => Recipe) public recipes;
    mapping(uint256 => bool) public recipeFrozen;

    uint256 public constant MAX_ERC1155_IDS = 32;

    error RecipeDisabled();
    error BadInput();
    error UnsupportedTokenType();
    error RecipeFrozenErr();
    error BurnFailed();

    constructor() Ownable(msg.sender) {}

    function setRecipe(uint256 recipeId, Recipe calldata recipe) external onlyOwner {
        if (recipeFrozen[recipeId]) revert RecipeFrozenErr();
        require(recipe.inputToken != address(0), "INPUT_0");
        require(recipe.outputKey != address(0), "OUTPUT_0");
        require(recipe.requiredTotal > 0, "REQ_0");
        require(recipe.outputAmount > 0, "OUT_0");
        if (recipe.mode == ConsumeMode.ESCROW) require(recipe.consumeTo != address(0), "CONSUME_0");

        if (recipe.tokenType == TokenType.ERC1155) {
            require(recipe.maxId >= recipe.minId, "BAD_RANGE");
        }

        recipes[recipeId] = recipe;
        emit RecipeSet(recipeId, recipe);
    }

    /// @notice Permanently freeze a recipe to prevent future changes (anti-rug).
    /// @dev Typically called after recipe is verified on testnet/mainnet.
    function freezeRecipe(uint256 recipeId) external onlyOwner {
        recipeFrozen[recipeId] = true;
        emit RecipeFrozen(recipeId);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Mix ERC1155 inputs into a lootbox key.
    /// @param recipeId Recipe id.
    /// @param ids ERC1155 ids.
    /// @param amounts ERC1155 amounts for each id.
    function mixERC1155(uint256 recipeId, uint256[] calldata ids, uint256[] calldata amounts) external nonReentrant whenNotPaused {
        Recipe memory r = recipes[recipeId];
        if (!r.enabled) revert RecipeDisabled();
        if (r.tokenType != TokenType.ERC1155) revert UnsupportedTokenType();
        if (ids.length == 0 || ids.length != amounts.length) revert BadInput();
        if (ids.length > MAX_ERC1155_IDS) revert BadInput();

        uint256 total;
        // Cheap duplicate check for small arrays.
        // We keep it O(n^2) but constrain practical usage (users will pass a few ids).
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            uint256 amt = amounts[i];
            if (amt == 0) revert BadInput();
            if (id < r.minId || id > r.maxId) revert BadInput();
            for (uint256 j = i + 1; j < ids.length; j++) {
                if (ids[j] == id) revert BadInput();
            }
            total += amt;
        }
        if (total != r.requiredTotal) revert BadInput();

        IERC1155 token = IERC1155(r.inputToken);

        if (r.mode == ConsumeMode.BURN) {
            // Requires inputToken to implement ERC1155Burnable and allow approved operators to burn.
            try IERC1155Burnable(r.inputToken).burnBatch(msg.sender, ids, amounts) {} catch {
                revert BurnFailed();
            }
        } else {
            // Escrow/sink: send inputs to consumeTo (e.g. burn EOA) to avoid withdraw-trust.
            token.safeBatchTransferFrom(msg.sender, r.consumeTo, ids, amounts, "");
        }

        ILootboxKeyMinter(r.outputKey).mint(msg.sender, r.outputKeyId, r.outputAmount);

        emit Mixed(recipeId, msg.sender, r.inputToken, r.requiredTotal, r.outputKey, r.outputKeyId, r.outputAmount);
    }

    /// @notice Mix ERC721 inputs into a lootbox key (escrow-only).
    /// @dev Generic ERC721 burn is not standard; if you need burn, make a specialized adapter.
    function mixERC721(uint256 recipeId, uint256[] calldata tokenIds) external nonReentrant whenNotPaused {
        Recipe memory r = recipes[recipeId];
        if (!r.enabled) revert RecipeDisabled();
        if (r.tokenType != TokenType.ERC721) revert UnsupportedTokenType();
        if (tokenIds.length != r.requiredTotal) revert BadInput();
        if (r.mode != ConsumeMode.ESCROW) revert BadInput();

        IERC721 token = IERC721(r.inputToken);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            token.safeTransferFrom(msg.sender, r.consumeTo, tokenIds[i]);
        }

        ILootboxKeyMinter(r.outputKey).mint(msg.sender, r.outputKeyId, r.outputAmount);

        emit Mixed(recipeId, msg.sender, r.inputToken, r.requiredTotal, r.outputKey, r.outputKeyId, r.outputAmount);
    }

    /// @notice Rescue escrowed ERC1155 tokens.
    function withdrawERC1155(address token, address to, uint256 id, uint256 amount) external onlyOwner {
        IERC1155(token).safeTransferFrom(address(this), to, id, amount, "");
    }

    /// @notice Rescue escrowed ERC721 tokens.
    function withdrawERC721(address token, address to, uint256 tokenId) external onlyOwner {
        IERC721(token).transferFrom(address(this), to, tokenId);
    }

    // --- ERC1155Receiver ---

    function supportsInterface(bytes4 interfaceId) public view virtual override(IERC165) returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC721Receiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure override returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    // --- ERC721Receiver ---

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return this.onERC721Received.selector;
    }
}


