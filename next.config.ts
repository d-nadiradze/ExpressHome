import type { NextConfig } from "next";

// Docker/VPS builds set SKIP_BUILD_CHECKS=1 — lint + tsc are slow and memory-heavy there.
const skipBuildChecks = process.env.SKIP_BUILD_CHECKS === "1";

const nextConfig: NextConfig = {
  output: "standalone",
  eslint: {
    ignoreDuringBuilds: skipBuildChecks,
  },
  typescript: {
    ignoreBuildErrors: skipBuildChecks,
  },
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
