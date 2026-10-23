import type { Metadata, Viewport } from "next";
import { Geist, Unbounded } from "next/font/google";
import "./globals.css";
import { ServiceWorker } from "@/components/ServiceWorker";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const unbounded = Unbounded({ subsets: ["latin"], variable: "--font-unbounded", display: "swap", weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: { default: "HARU — Work for Haru.", template: "%s, HARU" },
  description: "Every shift has a number. HARU shows what each shift earns, which paycheck it lands in, and how fast it clears your debt.",
  applicationName: "HARU",
  manifest: "/manifest.webmanifest",
  icons: { icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }, { url: "/icons/favicon-64.png", sizes: "64x64" }], apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "HARU", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#f3f1f0",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${unbounded.variable}`}>
      <body className="min-h-dvh">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
