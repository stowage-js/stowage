import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin, type ViteUserConfig } from "vitest/config";

import manifest from "./package.json" with { type: "json" };

const { hono, "@hono/node-server": nodeServer } = manifest.devDependencies;

/**
 * The directory pnpm stores each package's floor in. `@hono/node-server` is stored once per
 * Hono it was resolved against, and reaches Hono through that peer: its directory names the
 * floor of both.
 */
const floors = [
  { pattern: /^hono(?:\/|$)/u, storeDirectory: `/hono@${hono}/` },
  {
    pattern: /^@hono\/node-server(?:\/|$)/u,
    storeDirectory: `/@hono+node-server@${nodeServer}_hono@${hono}/`,
  },
];

const importer = fileURLToPath(new URL("package.json", import.meta.url));

/**
 * Spec 2: CI runs the Hono cell on Node at the floor of the peer range beside the newest
 * release. The cell's files import Hono where the newest is installed, so this run resolves
 * every import of either package as though this package made it, which reaches the floor
 * it installs.
 */
function atTheFloor(): Plugin {
  return {
    name: "stowage:hono-floor",
    enforce: "pre",
    async resolveId(source, _importer, options) {
      const floor = floors.find(({ pattern }) => pattern.test(source));

      if (floor === undefined) return null;

      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });

      // A run that reached another copy would pass as the floor's and prove nothing about it.
      if (resolved === null || !resolved.id.includes(floor.storeDirectory)) {
        throw new Error(`\`${source}\` resolved to ${resolved?.id ?? "nothing"}, not the floor`);
      }

      return resolved;
    },
  };
}

const config: ViteUserConfig = defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [atTheFloor()],
  test: {
    include: ["harness/node/src/hono*.test.ts", "harness/targets/src/hono*.test.ts"],
  },
});

export default config;
