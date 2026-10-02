import { readdir } from "node:fs/promises";

import { expect, test } from "vitest";

import changesetConfig from "../.changeset/config.json" with { type: "json" };
import harnessTargets from "../harness/targets/package.json" with { type: "json" };
import adapterAzureBlob from "../packages/adapter-azure-blob/package.json" with { type: "json" };
import adapterFs from "../packages/adapter-fs/package.json" with { type: "json" };
import adapterGcs from "../packages/adapter-gcs/package.json" with { type: "json" };
import adapterMemory from "../packages/adapter-memory/package.json" with { type: "json" };
import adapterS3 from "../packages/adapter-s3/package.json" with { type: "json" };
import conformance from "../packages/conformance/package.json" with { type: "json" };
import core from "../packages/core/package.json" with { type: "json" };
import hono from "../packages/hono/package.json" with { type: "json" };
import http from "../packages/http/package.json" with { type: "json" };

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
  adapterAzureBlob,
  adapterGcs,
  http,
  hono,
  conformance,
];

/** Spec 1: each integration and the framework it declares as its one peer. */
const frameworkOf: Readonly<Record<string, string>> = { [hono.name]: "hono" };

test("every package under `packages` is checked here", async () => {
  const entries = await readdir(new URL("../packages/", import.meta.url), {
    withFileTypes: true,
  });

  expect(entries.filter((entry) => entry.isDirectory())).toHaveLength(published.length);
});

test("the packages carry one version", () => {
  expect(new Set(published.map((manifest) => manifest.version)).size).toBe(1);
});

// ADR 0008: the release keeps the one version through a `fixed` group, so a package left out
// of it would be versioned on its own by the next `changeset version`.
test("the packages are released as one fixed group", () => {
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
  const framework = frameworkOf[manifest.name];
  const runtimeDependencies = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];

  expect(
    runtimeDependencies.filter((name) => !name.startsWith("@stowage/") && name !== framework),
  ).toEqual([]);
});

// Spec 1, ADR 0047: an integration declares its framework as a peer and nothing else as one.
test.each(published)("$name declares a peer only where it integrates a framework", (manifest) => {
  const framework = frameworkOf[manifest.name];

  expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(
    framework === undefined ? [] : [framework],
  );
});

// Spec 2, ADR 0050: the peer range starts at the floor CI runs.
test("@stowage/hono promises Hono 4 from the floor CI runs", () => {
  expect(hono.peerDependencies).toEqual({ hono: "^4.13.12" });
});

// Spec 1: nothing detects the runtime at import time, so no package hands one runtime an
// entry point of its own through a condition such as `bun`, `deno` or `workerd`.
test.each(published)("$name exports one entry point for every runtime", (manifest) => {
  expect(manifest.exports?.["."]).toBe("./dist/index.js");
});

// Spec 1, ADR 0046: the HTTP layer sits on the portable `Storage` and on nothing else, so
// that a server reaches it without an adapter or a framework coming along.
test("@stowage/http depends on @stowage/core alone", () => {
  expect(http.dependencies).toEqual({ "@stowage/core": "workspace:^" });
  expect("peerDependencies" in http).toBe(false);
});

// The harness builds its Hono applications with `withStorage` from the sources, whose types
// resolve the copy `@stowage/hono` installs, and Hono's `Context` has private members: two
// copies at two versions are two types to the compiler.
test("the harness serves Hono at the version @stowage/hono is checked against", () => {
  expect(harnessTargets.devDependencies.hono).toBe(hono.devDependencies.hono);
});
