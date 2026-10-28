import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Manrope } from "next/font/google";
import type { ReactNode } from "react";
import { Footer, Header } from "@/components/chrome";
import { textOf } from "@/lib/format";
import "./globals.css";

const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", weight: ["400", "500"], subsets: ["latin"] });

/** The public origin the share image's URL is made absolute against; without it Next.js uses localhost */
function siteUrl(): URL | undefined {
  const url = textOf(process.env.NEXT_PUBLIC_SITE_URL);
  return url !== null && /^https?:\/\//.test(url) && URL.canParse(url) ? new URL(url) : undefined;
}

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: "z402", template: "%s · z402" },
  description: "Agents pay for APIs in shielded Zcash: one deposit, then a signed voucher per call.",
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${plexMono.variable}`}>
      <body>
        <Header />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
