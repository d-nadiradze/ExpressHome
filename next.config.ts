import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.myhome.ge",
      },
      {
        protocol: "https",
        hostname: "cdn.myhome.ge",
      },
    ],
  },
  serverExternalPackages: ["playwright"],
};

export default nextConfig;
