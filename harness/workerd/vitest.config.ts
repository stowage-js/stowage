import { defineConfig, type ViteUserConfig } from "vitest/config";

// The `workerd` column runs apart from the root run: its results come from `workerd`, and
// Vitest on Node only reports them.
const config: ViteUserConfig = defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});

export default config;
