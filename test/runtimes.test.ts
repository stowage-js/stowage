import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

const read = async (path: string): Promise<string> =>
  await readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** The packages that run on Bun and Deno (spec 1). */
const packages = [
  "core",
  "adapter-memory",
  "adapter-fs",
  "adapter-s3",
  "adapter-azure-blob",
  "adapter-gcs",
  "http",
  "hono",
  "conformance",
];

// Spec 1: Bun and Deno have no floor, and each README names the version CI last ran green.
// `@stowage/nestjs` and `@stowage/nextjs` run on Node alone (spec 2), so theirs name neither.
// CI installs the version these two files pin, so a README naming another one names a
// version nothing ran.
const bunVersion = (await read(".bun-version")).trim();
const denoVersion = (await read(".dvmrc")).trim();

test.each(packages)("the README of %s names the Bun and Deno versions CI runs", async (name) => {
  expect(await read(`packages/${name}/README.md`)).toContain(
    `CI last ran green on Bun ${bunVersion} and Deno ${denoVersion}.`,
  );
});

test.each(["nestjs", "nextjs"])("the README of %s names no Bun or Deno version", async (name) => {
  expect(await read(`packages/${name}/README.md`)).not.toContain("CI last ran green on Bun");
});

test("the `workerd` harness pins the compatibility date of spec 1", async () => {
  expect(await read("harness/workerd/workerd.capnp")).toContain('compatibilityDate = "2026-09-01"');
});

test("the `workerd` harness switches off both flags that bring Node APIs", async () => {
  expect(await read("harness/workerd/workerd.capnp")).toContain(
    'compatibilityFlags = ["no_nodejs_compat", "no_nodejs_compat_v2"]',
  );
});
