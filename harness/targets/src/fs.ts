import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

import { fsStorage } from "../../../packages/adapter-fs/src/index.ts";
import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import { selectedCases } from "../../../packages/conformance/src/run.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";

/**
 * What one path may measure, the root counted in. macOS bounds it at 1024 bytes, and the
 * boundary key of spec 8.2 measures 1024 on its own, so no root leaves room for it there
 * and spec 6 has the adapter refuse it. Linux, where CI runs this cell, holds it.
 */
const pathByteLimit = platform === "darwin" ? 1024 : 4096;

const boundaryKeyBytes = 1024;

/** The whole `fast` tier, minus the one case no path below this root leaves room for. */
const runnable = (name: string): boolean =>
  name !== "put/accepted-keys" || tmpdir().length + boundaryKeyBytes < pathByteLimit;

// ADR 0006: `adapter-fs` is read against the suite like any other adapter. The harness
// reaches past `describeConformance` for the cases alone, so that the case the path limit
// rules out is left unrun rather than red on a machine whose temporary directory is one
// character too long.
export const fsCases = (): readonly ConformanceCaseSource[] =>
  selectedCases().filter((source) => runnable(source.name));

const roots: string[] = [];

export const fsTarget: ConformanceTarget = {
  name: "@stowage/adapter-fs",

  async createStorage() {
    const root = await mkdtemp(join(tmpdir(), "stowage-conformance-"));

    roots.push(root);

    return fsStorage({ root });
  },

  // The default of spec 8.2 deletes below the prefix on a storage of its own, and a
  // storage of its own is a root of its own here, which holds nothing the run wrote. What
  // the run leaves behind are the roots themselves, so each of them is removed whole.
  async cleanup() {
    await Promise.all(
      roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
    );
  },
};
