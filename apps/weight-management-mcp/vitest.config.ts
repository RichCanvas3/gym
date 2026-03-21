import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins:
    process.env.CF_WORKERS === "1"
      ? [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              // Test stub for service binding required by wrangler.jsonc
              serviceBindings: {
                MEDIA_PROXY() {
                  return new Response("stub", { status: 204 });
                },
              },
            },
          }),
        ]
      : [],
});

