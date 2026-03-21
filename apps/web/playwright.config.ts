import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3100",
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
    command: "node e2e/dev-server.mjs",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

