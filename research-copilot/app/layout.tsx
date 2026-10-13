import type { Metadata } from "next";
import { Source_Serif_4, Archivo } from "next/font/google";
import "./globals.css";

/**
 * Two faces, and the division of labour is the design.
 *
 * Source Serif 4 sets every figure and every sentence the model writes. It was
 * drawn for extended on-screen reading and ships true tabular lining figures,
 * so a column of revenue numbers aligns on the decimal the way it would in a
 * printed statement. Setting financial figures in a serif is not a stylistic
 * flourish — it is what annual reports and research notes have always done,
 * and it is the single thing that stops this looking like another dashboard.
 *
 * Archivo takes the interface chrome only: tabs, buttons, chips, column
 * labels. A grotesque at small sizes stays quiet and legible next to the
 * serif, and keeps the UI from competing with the document.
 *
 * Note the variable names. `--font-figure` feeds Tailwind's `mono` token,
 * because every number in this codebase is already marked up as `font-mono
 * tabular-nums` — the correct semantic for aligned columns, whatever face
 * fills it.
 */
const figure = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "600"],
  style: ["normal", "italic"],
  variable: "--font-figure",
  display: "swap",
});

const ui = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ui",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Research Copilot",
  description: "Evidence-bounded equity research. Every claim cites its source.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" className={`${figure.variable} ${ui.variable}`}>
      <body>{children}</body>
    </html>
  );
}
