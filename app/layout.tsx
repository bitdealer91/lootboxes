"use client";

import "./globals.css";
import type { ReactNode } from "react";
import { AppKitProvider } from "./providers/AppKitProvider";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <AppKitProvider>
          {children}
        </AppKitProvider>
      </body>
    </html>
  );
}


