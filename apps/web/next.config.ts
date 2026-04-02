import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  transpilePackages: ["@climb-gym/agent", "@climb-gym/ops", "@climb-gym/knowledge"],
  turbopack: {
    // Force correct monorepo root (avoid /home/barb/package-lock.json inference).
    root: path.resolve(__dirname, "..", ".."),
  },
};

export default nextConfig;
