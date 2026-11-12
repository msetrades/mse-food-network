import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FreshLink | Food Recovery Exchange",
  description: "Coordinate expiring surplus food offers, requests and accountable community handoffs.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
