import { defineChain } from "viem";

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 5031);
const chainName = process.env.NEXT_PUBLIC_CHAIN_NAME || "Somnia Mainnet";
const symbol = process.env.NEXT_PUBLIC_CHAIN_SYMBOL || "SOMI";
const rpc = process.env.NEXT_PUBLIC_RPC_URL || "https://api.infra.mainnet.somnia.network";

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


