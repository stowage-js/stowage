import { readdir, readFile } from "node:fs/promises";

import { expect, test } from "vitest";

import changesetConfig from "../.changeset/config.json" with { type: "json" };
import floors from "../harness/floors/package.json" with { type: "json" };
import harnessNextjs from "../harness/nextjs/package.json" with { type: "json" };
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
import nestjs from "../packages/nestjs/package.json" with { type: "json" };
import nextjs from "../packages/nextjs/package.json" with { type: "json" };

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
  nestjs,
  hono,
  nextjs,
  conformance,
];

/** Spec 1: each integration and the framework it declares as its one peer. */
const frameworkOf: Readonly<Record<string, string>> = {
  [nestjs.name]: "@nestjs/common",
  [hono.name]: "hono",
  [nextjs.name]: "next",
};

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
  expect(hono.peerDependencies).toEqual({ hono: `^${floors.devDependencies.hono}` });
});

test("@stowage/nestjs promises NestJS 12 from the floor CI runs", () => {
  expect(nestjs.peerDependencies).toEqual({
    "@nestjs/common": `^${floors.devDependencies["@nestjs/common"]}`,
  });
});

test("@stowage/nextjs promises Next.js 16 from the floor CI runs", () => {
  expect(nextjs.peerDependencies).toEqual({ next: `^${floors.devDependencies.next}` });
});

// Spec 2: one floor for the four NestJS packages, which CI runs together.
test("the floor of NestJS is one version of its four packages", () => {
  const { devDependencies: floor } = floors;

  expect(
    new Set([
      floor["@nestjs/common"],
      floor["@nestjs/core"],
      floor["@nestjs/platform-express"],
      floor["@nestjs/platform-fastify"],
    ]).size,
  ).toBe(1);
});

// Spec 1: nothing detects the runtime at import time, so no package hands one runtime an
// entry point of its own through a condition such as `bun`, `deno` or `workerd`.
test.each(published)("$name exports one entry point for every runtime", (manifest) => {
  expect(manifest.exports?.["."]).toBe("./dist/index.js");
});

// Spec 11: the module and the bridge are all the package holds, and the bridge is the
// layer's.
test("@stowage/nestjs depends on @stowage/core and @stowage/http alone", () => {
  expect(nestjs.dependencies).toEqual({
    "@stowage/core": "workspace:^",
    "@stowage/http": "workspace:^",
  });
});

// Spec 13, ADR 0047: the getter needs the portable `Storage` alone, and `server-only` is the
// application's, which Next.js aliases.
test("@stowage/nextjs depends on @stowage/core alone", () => {
  expect(nextjs.dependencies).toEqual({ "@stowage/core": "workspace:^" });
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

// The harness builds its NestJS applications with `@stowage/nestjs` from the sources, which
// resolve the copy the package installs, so that one NestJS answers both.
test("the harness serves NestJS at the version @stowage/nestjs is checked against", () => {
  for (const name of [
    "@nestjs/common",
    "@nestjs/core",
    "@nestjs/platform-express",
    "@nestjs/platform-fastify",
  ] as const) {
    expect(harnessTargets.devDependencies[name]).toBe(nestjs.devDependencies[name]);
  }
});

// The harness builds its Next.js application with the `next` @stowage/nextjs is checked
// against, which is the newest release of Next.js 16 that CI runs beside the floor.
test("the harness serves Next.js at the version @stowage/nextjs is checked against", () => {
  expect(harnessNextjs.dependencies.next).toBe(nextjs.devDependencies.next);
});

// Spec 13, ADR 0053: Next.js caches what its patched `fetch` answers, and no adapter opts out
// for that one framework, since every runtime would carry the option.
test("no adapter sets `cache` on its requests", async () => {
  const packages = new URL("../packages/", import.meta.url);
  const adapters = (await readdir(packages)).filter((name) => name.startsWith("adapter-"));
  const sources = (
    await Promise.all(
      adapters.map(async (adapter) =>
        (await readdir(new URL(`${adapter}/src/`, packages), { recursive: true }))
          .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
          .map((name) => `${adapter}/src/${name}`),
      ),
    )
  ).flat();

  expect(sources).not.toEqual([]);

  const texts = await Promise.all(
    sources.map(async (source) => await readFile(new URL(source, packages), "utf8")),
  );

  expect(sources.filter((_, index) => /\bcache\s*:|no-store/u.test(texts[index] ?? ""))).toEqual(
    [],
  );
});
