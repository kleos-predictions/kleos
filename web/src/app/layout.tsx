import type { Metadata } from "next";
import { Suspense } from "react";
import { Doto, IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import { Providers } from "./providers";
import { Nav } from "@/components/nav";
import "./globals.css";

const doto = Doto({ variable: "--font-doto", weight: "900", subsets: ["latin"] });
const grotesk = Space_Grotesk({ variable: "--font-space-grotesk", weight: ["400", "500", "700"], subsets: ["latin"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", weight: ["400", "500"], subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Kleos in Chaos",
  description: "Prediction Market with a Verifiable Reputation Layer",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${doto.variable} ${grotesk.variable} ${plexMono.variable} antialiased`}>
      <body className="flex min-h-dvh flex-col">
        <Providers>
          <Suspense>
            <Nav />
          </Suspense>
          {children}
        </Providers>
      </body>
    </html>
  );
}
