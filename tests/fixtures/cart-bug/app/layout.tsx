import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vault — Cart",
  description: "mypry race condition demo",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
