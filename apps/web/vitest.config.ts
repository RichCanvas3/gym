import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    restoreMocks: true,
    clearMocks: true,
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "**/node_modules/**", "**/.next/**"],
  },
});

