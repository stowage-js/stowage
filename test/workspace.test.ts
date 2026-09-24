import { readdir } from "node:fs/promises";

import { expect, test } from "vitest";

import changesetConfig from "../.changeset/config.json" with { type: "json" };
import adapterFs from "../packages/adapter-fs/package.json" with { type: "json" };
import adapterMemory from "../packages/adapter-memory/package.json" with { type: "json" };
import adapterS3 from "../packages/adapter-s3/package.json" with { type: "json" };
import conformance from "../packages/conformance/package.json" with { type: "json" };
import core from "../packages/core/package.json" with { type: "json" };

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly type?: string;
  readonly files?: readonly string[];
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

const published: readonly PackageManifest[] = [
  core,
  adapterMemory,
  adapterFs,
  adapterS3,
  conformance,
];

test("every package under `packages` is checked here", async () => {
  const entries = await readdir(new URL("../packages/", import.meta.url), {
    withFileTypes: true,
  });

  expect(entries.filter((entry) => entry.isDirectory())).toHaveLength(published.length);
});

test("the five packages carry one version", () => {
  expect(new Set(published.map((manifest) => manifest.version)).size).toBe(1);
});

// ADR 0008: the release keeps the one version through a `fixed` group, so a package left out
// of it would be versioned on its own by the next `changeset version`.
test("the five packages are released as one fixed group", () => {
  expect(changesetConfig.fixed).toEqual([published.map((manifest) => manifest.name)]);
});

test.each(published)("$name is published as ESM alone", (manifest) => {
  expect(manifest.type).toBe("module");
});

test.each(published)("$name declares the Node floor", (manifest) => {
  expect(manifest.engines?.node).toBe(">=24");
});

test.each(published)("$name keeps everything but `dist` out of the tarball", (manifest) => {
  expect(manifest.files).toEqual(["dist"]);
});

test.each(published)("$name has no runtime dependency outside `@stowage`", (manifest) => {
  const runtimeDependencies = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];

  expect(runtimeDependencies.filter((name) => !name.startsWith("@stowage/"))).toEqual([]);
});

// Spec 1: nothing detects the runtime at import time, so no package hands one runtime an
// entry point of its own through a condition such as `bun`, `deno` or `workerd`.
test.each(published)("$name exports one entry point for every runtime", (manifest) => {
  expect(manifest.exports?.["."]).toBe("./dist/index.js");
});
