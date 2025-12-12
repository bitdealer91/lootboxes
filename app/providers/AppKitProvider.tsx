"use client";

import { createContext, useContext, useMemo } from "react";
import { createAppKit } from "@reown/appkit";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { http, WagmiProvider, type Config } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { somniaMainnet } from "./chains";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID as string | undefined;
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || "https://api.infra.mainnet.somnia.network/";

type AppCtx = { appKit: ReturnType<typeof createAppKit>; wagmiConfig: Config; queryClient: QueryClient } | null;

const ReownContext = createContext<AppCtx>(null);

export function AppKitProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo<AppCtx>(() => {
    if (!projectId) return null;

    const adapter = new WagmiAdapter({
      projectId,
      networks: [somniaMainnet],
      transports: { [somniaMainnet.id]: http(rpcUrl) }
    });

    const appKit = createAppKit({
      adapters: [adapter],
      projectId,
      networks: [somniaMainnet],
      features: { analytics: false },
      metadata: {
        name: "Somnia Quests",
        description: "Flagship quests for Somnia Mainnet",
        url: typeof window !== "undefined" ? window.location.origin : "https://quests.somnia.network",
        icons: ["/assets/somnia-logo.svg"]
      },
      themeMode: "dark"
    });

    const queryClient = new QueryClient();
    const wagmiConfig = (adapter as unknown as { wagmiConfig: Config }).wagmiConfig;
    return { appKit, wagmiConfig, queryClient };
  }, []);

  if (!value) return children as React.ReactNode;
  const { wagmiConfig, queryClient } = value;

  return (
    <ReownContext.Provider value={value}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    </ReownContext.Provider>
  );
}

export function useReown() {
  return useContext(ReownContext);
}


