import hre from "hardhat";

const { ethers } = hre;

/**
 * Build calldata for Mixer.setRecipe(...) to switch recipe to ESCROW mode.
 *
 * Usage:
 * cd hardhat
 * MIXER_ADDRESS=0x... \
 * INPUT_TOKEN=0x... \
 * OUTPUT_KEY=0x... \
 * RECIPE_ID=1 \
 * REQUIRED_TOTAL=32 \
 * MIN_ID=1 \
 * MAX_ID=8 \
 * OUTPUT_KEY_ID=1 \
 * OUTPUT_AMOUNT=1 \
 * CONSUME_TO=0x000000000000000000000000000000000000dEaD \
 * npx hardhat run ./scripts/encode-safe-mixer-recipe-escrow.js --network hardhat
 */
async function main() {
  const mixer = process.env.MIXER_ADDRESS;
  const inputToken = process.env.INPUT_TOKEN;
  const outputKey = process.env.OUTPUT_KEY;
  const consumeTo = process.env.CONSUME_TO;

  if (!mixer) throw new Error("Missing MIXER_ADDRESS");
  if (!inputToken) throw new Error("Missing INPUT_TOKEN");
  if (!outputKey) throw new Error("Missing OUTPUT_KEY");
  if (!consumeTo) throw new Error("Missing CONSUME_TO");

  const recipeId = BigInt(process.env.RECIPE_ID || "1");
  const minId = BigInt(process.env.MIN_ID || "1");
  const maxId = BigInt(process.env.MAX_ID || "8");
  const requiredTotal = BigInt(process.env.REQUIRED_TOTAL || "32");
  const outputKeyId = BigInt(process.env.OUTPUT_KEY_ID || "1");
  const outputAmount = BigInt(process.env.OUTPUT_AMOUNT || "1");

  // TokenType.ERC1155 = 0
  // ConsumeMode.ESCROW = 0
  const recipe = {
    tokenType: 0,
    inputToken,
    minId,
    maxId,
    requiredTotal,
    mode: 0,
    consumeTo,
    outputKey,
    outputKeyId,
    outputAmount,
    enabled: true
  };

  const iface = new ethers.Interface([
    "function setRecipe(uint256 recipeId,(uint8 tokenType,address inputToken,uint256 minId,uint256 maxId,uint256 requiredTotal,uint8 mode,address consumeTo,address outputKey,uint256 outputKeyId,uint256 outputAmount,bool enabled) recipe)"
  ]);

  const data = iface.encodeFunctionData("setRecipe", [recipeId, recipe]);

  console.log("=== Safe / multisig tx ===");
  console.log("To:", mixer);
  console.log("Value:", "0");
  console.log("Data:", data);
  console.log("");
  console.log("Decoded recipe:");
  console.log(
    JSON.stringify(
      {
        recipeId: recipeId.toString(),
        tokenType: recipe.tokenType,
        inputToken: recipe.inputToken,
        minId: recipe.minId.toString(),
        maxId: recipe.maxId.toString(),
        requiredTotal: recipe.requiredTotal.toString(),
        mode: recipe.mode,
        consumeTo: recipe.consumeTo,
        outputKey: recipe.outputKey,
        outputKeyId: recipe.outputKeyId.toString(),
        outputAmount: recipe.outputAmount.toString(),
        enabled: recipe.enabled
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
