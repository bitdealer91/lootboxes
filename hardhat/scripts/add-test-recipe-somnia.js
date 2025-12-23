import hre from "hardhat";
const { ethers } = hre;

// Adds a NON-FROZEN test recipe to an existing Mixer on Somnia mainnet.
// This is for UX/mechanics testing with small requiredTotal.
//
// Usage:
// MIXER_ADDRESS=0x... LOOTBOX_KEY_ADDRESS=0x... \
// ODYSSEY_KEYS=0x2d53...5306 TEST_RECIPE_ID=2 TEST_REQUIRED_TOTAL=1 \
//   npx hardhat run ./scripts/add-test-recipe-somnia.js --network somnia
//
// Notes:
// - consumeTo is set to the Mixer address (escrow), so keys are NOT burned.
// - After testing, disable this recipe (or freeze it) to avoid abuse.

function env(name, fallback) {
  const v = process.env[name];
  return v && v.length ? v : fallback;
}

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function main() {
  await hre.run("compile");
  if (hre.network.name !== "somnia") {
    throw new Error(
      `Wrong network '${hre.network.name}'. Run: npx hardhat run ./scripts/add-test-recipe-somnia.js --network somnia`
    );
  }

  const mixerAddr = env("MIXER_ADDRESS", "0x9306d3Bd88b5647805404c90637A51cB00Eb5e2C");
  const lootboxKeyAddr = env("LOOTBOX_KEY_ADDRESS", "0x00F329c003d61709A4132A3e68Cc66f2d0Ad9EDD");
  const odysseyKeys = env("ODYSSEY_KEYS", "0x2d535a2588E7c3f5F213F3b3324F44E146Ca5306");

  const recipeId = BigInt(env("TEST_RECIPE_ID", "2"));
  const requiredTotal = BigInt(env("TEST_REQUIRED_TOTAL", "1"));

  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log("Network:", hre.network.name, "chainId:", net.chainId.toString());
  console.log("Deployer:", deployer.address);
  console.log("Mixer:", mixerAddr);

  const mixer = await ethers.getContractAt("Mixer", mixerAddr, deployer);

  // tokenType=0 (ERC1155), mode=0 (ESCROW)
  const tx = await mixer.setRecipe(recipeId, {
    tokenType: 0,
    inputToken: odysseyKeys,
    minId: 1,
    maxId: 8,
    requiredTotal,
    mode: 0,
    consumeTo: mixerAddr, // escrow in mixer
    outputKey: lootboxKeyAddr,
    outputKeyId: 1,
    outputAmount: 1,
    enabled: true
  });

  console.log("Sending tx:", tx.hash);
  await tx.wait();
  console.log(`Test recipe set: recipeId=${recipeId.toString()} requiredTotal=${requiredTotal.toString()} (NOT frozen)`);

  console.log("\nNext:");
  console.log(`- User approval on Odyssey keys: setApprovalForAll(${mixerAddr}, true)`);
  console.log(`- User mix call: mixERC1155(${recipeId.toString()}, [<id 1..8>], [${requiredTotal.toString()}])`);
  console.log("\nAfter testing (recommended):");
  console.log(`- Disable recipe: setRecipe(${recipeId.toString()}, { ..., enabled: false })`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


