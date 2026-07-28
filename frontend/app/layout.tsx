import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { DragonMark, GetStartedButton } from "@/components/Chrome";
import { WalletProvider } from "@/lib/wallet";

const sans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});
const mono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});
const display = Instrument_Serif({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400"],
});

const TITLE = "Kairos Layer — confidential dark pool on Ethereum";
const DESCRIPTION =
  "Encrypted orders matched against each other in a TEE; only the unmatched residual reaches Uniswap. Built on iExec Nox, live on Ethereum Sepolia.";

export const metadata: Metadata = {
  // Needed for absolute URLs in the social card; opengraph-image.png in this
  // directory is picked up automatically.
  metadataBase: new URL("https://kairos-layerr.vercel.app"),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${display.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <WalletProvider>
          <DragonMark />
          <GetStartedButton />
          <div className="lg:flex relative z-10">
            <Nav />
            <main className="flex-1 lg:ml-[264px] min-w-0">
              <div className="max-w-[900px] px-6 lg:px-12 py-10 lg:py-16">{children}</div>
              <footer className="max-w-[900px] px-6 lg:px-12 pb-14">
                <div className="border-t border-rule pt-5 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-ink-3">
                  <span>Kairos Layer</span>
                  <span>Ethereum Sepolia · chain 11155111</span>
                  <span>Built on iExec Nox</span>
                  <span>Testnet software — not audited for production use</span>
                </div>
              </footer>
            </main>
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
