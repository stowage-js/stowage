import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin, type ViteUserConfig } from "vitest/config";

import manifest from "./package.json" with { type: "json" };

/**
 * Spec 2: CI runs the Hono cell on Node at the floor of the peer range beside the newest
 * release. The cell's files import Hono where the newest is installed; this run resolves
 * every import of either package as though this package made it, which reaches the floor
 * it installs. `@hono/node-server` then reaches Hono through its own peer, which pnpm
 * resolved to the same floor.
 */
const importer = fileURLToPath(new URL("package.json", import.meta.url));

/** Each package this run moves to the floor, and the directory pnpm stores its floor in. */
const floors = [
  { pattern: /^hono(?:\/|$)/u, stored: `/hono@${manifest.devDependencies.hono}/` },
  {
    pattern: /^@hono\/node-server(?:\/|$)/u,
    stored: `/@hono+node-server@${manifest.devDependencies["@hono/node-server"]}_`,
  },
];

function atTheFloor(): Plugin {
  return {
    name: "stowage:hono-floor",
    enforce: "pre",
    async resolveId(source, _importer, options) {
      const floor = floors.find(({ pattern }) => pattern.test(source));

      if (floor === undefined) return null;

      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });

      // A run that reached another copy would pass as the floor's and prove nothing about it.
      if (resolved === null || !resolved.id.includes(floor.stored)) {
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
    // The Hono cell on Node and the repository test that reads its `Response`.
    include: ["harness/node/src/hono*.test.ts", "harness/targets/src/hono*.test.ts"],
  },
});

export default config;
