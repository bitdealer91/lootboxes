import "@nomicfoundation/hardhat-ethers";

// Optional: load env vars if present (user runs locally).
// eslint-disable-next-line import/no-unassigned-import
import "dotenv/config";

/** @type {import('hardhat/config').HardhatUserConfig} */
const config = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  networks: {
    // Somnia mainnet (chainId 5031)
    somnia: {
      url: process.env.SOMNIA_RPC_URL || "",
      chainId: 5031,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    },
    // Somnia testnet (chainId 50312)
    somniaTest: {
      url: process.env.SOMNIA_TEST_RPC_URL || "https://dream-rpc.somnia.network",
      chainId: 50312,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    }
  }
};

export default config;



