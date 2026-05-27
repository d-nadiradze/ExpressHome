import type { Metadata } from "next";
import { Toaster } from "react-hot-toast";
import ThemeProvider from "@/components/ThemeProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "ExpressHome",
  description: "Parse and publish listings to myhome.ge and ss.ge",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ka" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          {children}
          <Toaster position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
