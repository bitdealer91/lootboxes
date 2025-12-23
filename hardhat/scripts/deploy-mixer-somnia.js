import hre from "hardhat";
const { ethers } = hre;

// Deploy Mixer + LootboxKey, set Odyssey recipe on Somnia mainnet.
// Usage (locally):
// SOMNIA_RPC_URL=... DEPLOYER_PRIVATE_KEY=... ODYSSEY_KEYS=0x2d53...5306 \
//   npx hardhat run ./scripts/deploy-mixer-somnia.js --network somnia

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function main() {
  // Ensure artifacts exist
  await hre.run("compile");

  if (hre.network.name !== "somnia") {
    throw new Error(
      `Wrong network '${hre.network.name}'. Run: npx hardhat run ./scripts/deploy-mixer-somnia.js --network somnia`
    );
  }

  // Fail fast if RPC/private key not provided
  mustEnv("SOMNIA_RPC_URL");
  mustEnv("DEPLOYER_PRIVATE_KEY");

  const odysseyKeys = (process.env.ODYSSEY_KEYS || "0x2d535a2588E7c3f5F213F3b3324F44E146Ca5306").toLowerCase();

  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log("Network:", hre.network.name, "chainId:", net.chainId.toString());
  console.log("Deployer:", deployer.address);

  const burnSink = (process.env.BURN_SINK || "0x000000000000000000000000000000000000dEaD").toLowerCase();

  const LootboxKey = await ethers.getContractFactory("LootboxKey");
  const lootboxKey = await LootboxKey.deploy("");
  await lootboxKey.waitForDeployment();
  console.log("LootboxKey:", await lootboxKey.getAddress());

  const Mixer = await ethers.getContractFactory("Mixer");
  const mixer = await Mixer.deploy();
  await mixer.waitForDeployment();
  console.log("Mixer:", await mixer.getAddress());

  // Grant mint role
  const minterRole = await lootboxKey.MINTER_ROLE();
  let tx = await lootboxKey.grantRole(minterRole, await mixer.getAddress());
  await tx.wait();
  console.log("Granted MINTER_ROLE to Mixer");

  // RecipeId 1: 100 any ids 1..8 from Odyssey => 1 LootboxKey id=1
  tx = await mixer.setRecipe(1, {
    tokenType: 0, // ERC1155
    inputToken: odysseyKeys,
    minId: 1,
    maxId: 8,
    requiredTotal: 100,
    mode: 0, // ESCROW
    consumeTo: burnSink, // send inputs directly to burn address (no withdraw trust)
    outputKey: await lootboxKey.getAddress(),
    outputKeyId: 1,
    outputAmount: 1,
    enabled: true
  });
  await tx.wait();
  console.log("Recipe #1 set");

  tx = await mixer.freezeRecipe(1);
  await tx.wait();
  console.log("Recipe #1 frozen");

  console.log("Done.");
  console.log(JSON.stringify({
    chainId: 5031,
    odysseyKeys,
    mixer: await mixer.getAddress(),
    lootboxKey: await lootboxKey.getAddress(),
    recipeId: 1,
    burnSink
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


