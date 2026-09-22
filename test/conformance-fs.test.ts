import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

import { describe, test } from "vitest";

import { fsStorage } from "../packages/adapter-fs/src/index.ts";
import { conformanceCaseSources } from "../packages/conformance/src/cases/index.ts";
import { describeCases } from "../packages/conformance/src/describe.ts";
import type { ConformanceTarget } from "../packages/conformance/src/target.ts";

/** The operations `adapter-fs` carries. The rest of the tier follows the ones it owes. */
const covered = ["put/", "get/", "stat/", "exists/", "list/"];

/**
 * What one path may measure, the root counted in. macOS bounds it at 1024 bytes, and the
 * boundary key of spec 8.2 measures 1024 on its own, so no root leaves room for it there
 * and spec 6 has the adapter refuse it. Linux, where CI runs this cell, holds it.
 */
const pathByteLimit = platform === "darwin" ? 1024 : 4096;

const boundaryKeyBytes = 1024;

const runnable = (name: string): boolean => {
  if (!covered.some((group) => name.startsWith(group))) return false;
  if (name !== "put/accepted-keys") return true;

  return tmpdir().length + boundaryKeyBytes < pathByteLimit;
};

const roots: string[] = [];

// ADR 0006: `adapter-fs` is read against the suite like any other adapter. It reaches
// past `describeConformance` for the cases alone, because the adapter carries part of the
// parity core so far and the whole tier is what `describeConformance` runs.
const target: ConformanceTarget = {
  name: "@stowage/adapter-fs",

  async createStorage() {
    const root = await mkdtemp(join(tmpdir(), "stowage-conformance-"));

    roots.push(root);

    return fsStorage({ root });
  },

  // The default of spec 8.2 deletes below the prefix, which this adapter does not carry
  // yet. A root of its own per storage is removed whole instead.
  async cleanup() {
    await Promise.all(
      roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
    );
  },
};

describeCases(
  conformanceCaseSources.filter((source) => runnable(source.name)),
  target,
  { describe, test },
);
