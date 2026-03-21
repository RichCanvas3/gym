import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "./e2e-live",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:3200",
    launchOptions: {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [
          path.join(process.cwd(), "e2e", ".libs", "root", "usr", "lib", "x86_64-linux-gnu"),
          process.env.LD_LIBRARY_PATH || "",
        ]
          .filter(Boolean)
          .join(":"),
      },
    },
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:3200",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: "3200",
    },
  },
});

