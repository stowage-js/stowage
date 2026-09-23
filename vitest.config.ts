import { configDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "harness/*/src/**/*.test.ts", "test/**/*.test.ts"],
    // Each of these runtimes is a column of spec 2 with a run of its own: `pnpm test:bun`,
    // `pnpm test:deno` and `pnpm test:workerd`. Bun and Deno hand the cases to `bun:test` and
    // `Deno.test`; the `workerd` harness has a Vitest config of its own.
    exclude: [...configDefaults.exclude, "harness/bun/**", "harness/deno/**", "harness/workerd/**"],
  },
});

export default config;
