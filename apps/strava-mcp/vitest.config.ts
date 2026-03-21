import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins:
    process.env.CF_WORKERS === "1"
      ? [
          cloudflareTest({
            main: "./src/index.ts",
            miniflare: {
              compatibilityDate: "2025-03-10",
              compatibilityFlags: ["nodejs_compat"],
              bindings: { MCP_API_KEY: "test" },
              d1Databases: { DB: "local-test-db" },
            },
          }),
        ]
      : [],
});

