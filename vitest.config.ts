import { configDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "harness/*/src/**/*.test.ts",
      "scripts/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    // Each of these runtimes is a column of spec 2 with a run of its own: `pnpm test:bun`,
    // `pnpm test:deno` and `pnpm test:workerd`. Bun and Deno hand the cases to `bun:test` and
    // `Deno.test`; the `workerd` harness has a Vitest config of its own.
    exclude: [...configDefaults.exclude, "harness/bun/**", "harness/deno/**", "harness/workerd/**"],
    // `pnpm test --coverage` turns it on. SonarQube Cloud reads `lcov.info` and counts only the
    // packages' sources, so the harnesses and the stubs that only tests import stay out of it.
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "packages/*/src/stubs.ts"],
      reporter: ["text-summary", "lcovonly"],
    },
  },
});

export default config;
