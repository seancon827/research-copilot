import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

/**
 * Type pairing is doing real work here, not decoration.
 *
 * IBM Plex Mono for data: it was designed for IBM's technical documentation, has
 * true tabular figures, and a distinct 0/O — which matters when someone is
 * reading a share count. Inter for model prose: high x-height, reads well at 15px
 * in long paragraphs where a monospace face would be exhausting.
 *
 * The two faces are how the reader tells data from inference at a glance.
 */
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Research Copilot",
  description: "Evidence-bounded equity research. Every claim cites its source.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
