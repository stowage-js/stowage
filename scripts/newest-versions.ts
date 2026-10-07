import { readFile, writeFile } from "node:fs/promises";

import floors from "../harness/floors/package.json" with { type: "json" };
import nextjsHarness from "../harness/nextjs/package.json" with { type: "json" };
import hono from "../packages/hono/package.json" with { type: "json" };
import nestjs from "../packages/nestjs/package.json" with { type: "json" };
import nextjs from "../packages/nextjs/package.json" with { type: "json" };

export interface Integration {
  readonly manifest: { readonly name: string };
  readonly peerRange: string;
  readonly floor: string;
  /** The newest release of the framework's major, which CI runs and Renovate moves. */
  readonly newest: string;
}

/**
 * The framework of each integration. The package's own development install pins the newest,
 * and the Next.js harness for `next`, which Renovate moves together.
 */
export const integrations: readonly Integration[] = [
  {
    manifest: nestjs,
    peerRange: nestjs.peerDependencies["@nestjs/common"],
    floor: floors.devDependencies["@nestjs/common"],
    newest: nestjs.devDependencies["@nestjs/common"],
  },
  {
    manifest: hono,
    peerRange: hono.peerDependencies.hono,
    floor: floors.devDependencies.hono,
    newest: hono.devDependencies.hono,
  },
  {
    manifest: nextjs,
    peerRange: nextjs.peerDependencies.next,
    floor: floors.devDependencies.next,
    newest: nextjsHarness.devDependencies.next,
  },
];

export const readmeOf = ({ manifest }: Integration): URL =>
  new URL(`../packages/${manifest.name.replace("@stowage/", "")}/README.md`, import.meta.url);

const ranVersion = /(CI\s+ran\s+)(\d+\.\d+\.\d+)/u;

/** The version a README names as the newest CI ran, or `undefined` where it names none. */
export const ranVersionOf = (readme: string): string | undefined => ranVersion.exec(readme)?.[2];

export function withNewestVersion(readme: string, newest: string): string {
  if (!ranVersion.test(readme)) throw new Error("The README names no version CI ran");

  return readme.replace(ranVersion, `$1${newest}`);
}

// Spec 16: a README names the newest version CI ran at its release, so the version pull request
// writes it, and between releases a README may name an older one than Renovate has moved to.
// Every release versions the eleven packages together (ADR 0008), so no README is rewritten for
// a release its package sits out.
if (import.meta.main) {
  await Promise.all(
    integrations.map(async (integration) => {
      const readme = readmeOf(integration);

      await writeFile(
        readme,
        withNewestVersion(await readFile(readme, "utf8"), integration.newest),
      );
    }),
  );
}
