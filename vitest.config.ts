import { defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "harness/*/src/**/*.test.ts", "test/**/*.test.ts"],
  },
});

export default config;
