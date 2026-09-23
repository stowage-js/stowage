import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

const read = async (path: string): Promise<string> =>
  await readFile(new URL(`../${path}`, import.meta.url), "utf8");

const packages = ["core", "adapter-memory", "adapter-fs", "adapter-s3", "conformance"];

// Spec 1: Bun and Deno have no floor, and each README names the version CI last ran green.
// CI installs the version these two files pin, so a README naming another one names a
// version nothing ran.
const bun = (await read(".bun-version")).trim();
const deno = (await read(".dvmrc")).trim();

test.each(packages)("the README of %s names the Bun and Deno versions CI runs", async (name) => {
  expect(await read(`packages/${name}/README.md`)).toContain(
    `CI last ran green on Bun ${bun} and Deno ${deno}.`,
  );
});

test("the `workerd` harness pins the compatibility date of spec 1", async () => {
  expect(await read("harness/workerd/workerd.capnp")).toContain('compatibilityDate = "2026-09-01"');
});
