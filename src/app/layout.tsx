import type { Metadata } from "next";
import { Toaster } from "react-hot-toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "MyHome Parser",
  description: "Auto-import listings from myhome.ge",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ka">
      <body>
        {children}
        <Toaster position="top-right" />
      </body>
    </html>
  );
}
