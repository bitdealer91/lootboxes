import { defineChain } from "viem";

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 1);
const chainName = process.env.NEXT_PUBLIC_CHAIN_NAME || (chainId === 50312 ? "Somnia Testnet" : "Somnia Mainnet");
const symbol = process.env.NEXT_PUBLIC_CHAIN_SYMBOL || (chainId === 50312 ? "STT" : "SOMI");
const rpc = process.env.NEXT_PUBLIC_RPC_URL || (chainId === 50312 ? "https://dream-rpc.somnia.network" : "https://api.infra.mainnet.somnia.network/");

export const somniaChain = defineChain({
  id: chainId,
  name: chainName,
  nativeCurrency: { name: symbol, symbol, decimals: 18 },
  rpcUrls: {
    default: {
      http: [rpc]
    },
    public: {
      http: [rpc]
    }
  }
});


