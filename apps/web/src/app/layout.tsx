import type { Metadata, Viewport } from "next";
import { Akt, Lexend_Deca, Manrope, Ubuntu_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Footer, Header } from "@/components/chrome";
import "./globals.css";

const akt = Akt({ variable: "--font-akt", weight: ["400", "500"], subsets: ["latin"] });
const lexendDeca = Lexend_Deca({ variable: "--font-lexend-deca", weight: ["300"], subsets: ["latin"] });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });
const ubuntuMono = Ubuntu_Mono({ variable: "--font-ubuntu-mono", weight: ["400"], subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "z402", template: "%s · z402" },
  description: "Agents pay for APIs in shielded Zcash: one deposit, then a signed voucher per call.",
};

export const viewport: Viewport = {
  themeColor: "#161616",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${akt.variable} ${lexendDeca.variable} ${manrope.variable} ${ubuntuMono.variable} antialiased`}
    >
      <body>
        <Header />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
