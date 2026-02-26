import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@climb-gym/agent", "@climb-gym/ops", "@climb-gym/knowledge"],
};

export default nextConfig;
