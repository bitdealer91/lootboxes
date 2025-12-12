import { defineChain } from "viem";

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 1);

export const somniaMainnet = defineChain({
  id: chainId,
  name: "Somnia Mainnet",
  nativeCurrency: { name: "SOMI", symbol: "SOMI", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_RPC_URL || "https://api.infra.mainnet.somnia.network/"]
    },
    public: {
      http: [process.env.NEXT_PUBLIC_RPC_URL || "https://api.infra.mainnet.somnia.network/"]
    }
  }
});


