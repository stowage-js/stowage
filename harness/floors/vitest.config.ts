import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin, type ViteUserConfig } from "vitest/config";

import manifest from "./package.json" with { type: "json" };

const { devDependencies: floor } = manifest;

/** A pnpm store directory's name for `name` at its floor, which escapes the scope's `/`. */
const storeName = (name: keyof typeof floor): string => `${name.replace("/", "+")}@${floor[name]}`;

/**
 * Whether a resolved path lies in the directory pnpm stores a package's floor in. pnpm
 * appends the peers a package was resolved against to its directory's name after a `_`,
 * and shortens a long name with a hash after its start. `@hono/node-server` is stored once
 * per Hono it was resolved against and reaches Hono through that peer: its directory names
 * the floor of both.
 */
const floors: readonly { pattern: RegExp; inStore: (id: string) => boolean }[] = [
  { pattern: /^hono(?:\/|$)/u, inStore: (id) => id.includes(`/${storeName("hono")}/`) },
  {
    pattern: /^@hono\/node-server(?:\/|$)/u,
    inStore: (id) => id.includes(`/${storeName("@hono/node-server")}_${storeName("hono")}/`),
  },
  ...(
    [
      "@nestjs/common",
      "@nestjs/core",
      "@nestjs/platform-express",
      "@nestjs/platform-fastify",
    ] as const
  ).map((name) => ({
    pattern: new RegExp(`^${name}(?:/|$)`, "u"),
    inStore: (id: string) =>
      id.includes(`/${storeName(name)}/`) || id.includes(`/${storeName(name)}_`),
  })),
];

const importer = fileURLToPath(new URL("package.json", import.meta.url));

/**
 * Spec 2: CI runs the Hono cell, both NestJS cells and the Next.js cell on Node at the floor
 * of each peer range beside the newest release. The cells' files import the frameworks where
 * the newest is installed, so this run resolves every import of a framework's packages as
 * though this package made it, which reaches the floor it installs.
 */
function atTheFloor(): Plugin {
  return {
    name: "stowage:floors",
    enforce: "pre",
    async resolveId(source, _importer, options) {
      const pinned = floors.find(({ pattern }) => pattern.test(source));

      if (pinned === undefined) return null;

      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });

      // A run that reached another copy would pass as the floor's and prove nothing about it.
      if (resolved === null || !pinned.inStore(resolved.id)) {
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
    include: [
      "harness/node/src/hono*.test.ts",
      "harness/targets/src/hono*.test.ts",
      "harness/node/src/nestjs*.test.ts",
      "harness/node/src/nextjs*.test.ts",
    ],
    // Nothing in this process imports Next.js, which `next build` and `next start` run in
    // processes of their own: the harness builds the application with the `next` this
    // package installs, and refuses a build that resolved another.
    env: { STOWAGE_NEXTJS_PACKAGE: "harness/floors" },
  },
});

export default config;
