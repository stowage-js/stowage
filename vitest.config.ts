import { configDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "harness/*/src/**/*.test.ts", "test/**/*.test.ts"],
    // These two harnesses hand the cases to `bun:test` and `Deno.test`, and each runs under
    // its own runtime (`pnpm test:bun`, `pnpm test:deno`) rather than under Vitest.
    exclude: [...configDefaults.exclude, "harness/bun/**", "harness/deno/**"],
  },
});

export default config;
