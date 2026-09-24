import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

import adapterFs from "../packages/adapter-fs/package.json" with { type: "json" };
import adapterMemory from "../packages/adapter-memory/package.json" with { type: "json" };
import adapterS3 from "../packages/adapter-s3/package.json" with { type: "json" };
import conformance from "../packages/conformance/package.json" with { type: "json" };
import core from "../packages/core/package.json" with { type: "json" };

const read = async (path: string): Promise<string> =>
  await readFile(new URL(`../${path}`, import.meta.url), "utf8");

const headingsOf = (text: string): string[] =>
  [...text.matchAll(/^## (.+)$/gmu)].map((match) => match[1] ?? "");

const tsSourcesOf = (text: string): string[] =>
  [...text.matchAll(/^```ts\n([\s\S]*?)^```$/gmu)].map((match) => match[1] ?? "");

const readmeOf = async (manifest: { readonly name: string }): Promise<string> =>
  await read(`packages/${manifest.name.replace("@stowage/", "")}/README.md`);

const published = [core, adapterMemory, adapterFs, adapterS3, conformance];

/** Spec 10 gives `@stowage/conformance` a shape of its own and these four the same sections. */
const sectioned = [core, adapterMemory, adapterFs, adapterS3];

/** Spec 10: the sections a README carries, in this order, before anything else it holds. */
const packageSections = ["Install", "Example", "Runtimes", "Limits", "Notes", "Specification"];

test.each(sectioned)(
  "the README of $name carries the sections of spec 10 in order",
  async (manifest) => {
    const headings = headingsOf(await readmeOf(manifest));

    expect(headings.slice(0, packageSections.length)).toEqual(packageSections);
  },
);

test("the README of @stowage/conformance carries the shape spec 10 gives it", async () => {
  const text = await readmeOf(conformance);

  expect(text).toContain("describeConformance");
  expect(text).toContain("runAll");
  expect(text).toContain("`workerd`");
  expect(text).toContain("bun:test");
  expect(text).toContain("Deno.test");
  expect(text).toContain("[`@stowage/adapter-memory`]");
  expect(headingsOf(text)).toContain("Specification");
});

const semverAt = (version: string): number[] => version.split(".").map(Number);

function compareVersions(left: string, right: string): number {
  const [a, b] = [semverAt(left), semverAt(right)];

  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);

    if (difference !== 0) return difference;
  }

  return 0;
}

// Spec 10 links the spec at the tag of the package's release, which changesets names
// `<name>@<version>`. The version the tag names is the release the README goes out with, so
// it is never older than the manifest's: a version bump that leaves the link behind fails
// here instead of sending a caller to promises an older release made.
test.each(published)(
  "the README of $name links the spec at the tag of its release",
  async (manifest) => {
    const text = await readmeOf(manifest);
    const links = [
      ...text.matchAll(
        /https:\/\/github\.com\/stowage-js\/stowage\/blob\/([^/]+\/[^/@]+)@([^/]+)\/docs\/spec\.md/gu,
      ),
    ];

    expect(links.length).toBeGreaterThan(0);

    for (const [, name, version = ""] of links) {
      expect(name).toBe(manifest.name);
      expect(compareVersions(version, manifest.version)).toBeGreaterThanOrEqual(0);
    }

    expect(text).not.toMatch(/stowage\/blob\/main\/docs\/spec\.md/u);
  },
);

const callsAfterConstruction = (block: string): string =>
  block.slice(block.indexOf("await storage.put"));

test("the root README opens with the same four calls against `fsStorage` and `s3Storage`", async () => {
  const [onFs = "", onS3 = ""] = tsSourcesOf(await read("README.md"));

  expect(onFs).toContain("fsStorage(");
  expect(onS3).toContain("s3Storage(");

  for (const call of ["put(", "get(", "list(", "delete("]) {
    expect(callsAfterConstruction(onFs)).toContain(`storage.${call}`);
  }

  expect(callsAfterConstruction(onS3)).toBe(callsAfterConstruction(onFs));
});

test("the root README shows the package family", async () => {
  const text = await read("README.md");

  for (const manifest of published) {
    expect(text).toContain(manifest.name);
  }
});
