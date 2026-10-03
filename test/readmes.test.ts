import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

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

const read = async (path: string): Promise<string> =>
  await readFile(new URL(`../${path}`, import.meta.url), "utf8");

const headingsOf = (text: string): string[] =>
  [...text.matchAll(/^## (.+)$/gmu)].map((match) => match[1] ?? "");

const tsSourcesOf = (text: string): string[] =>
  [...text.matchAll(/^```ts\n([\s\S]*?)^```$/gmu)].map((match) => match[1] ?? "");

const readmeOf = async (manifest: { readonly name: string }): Promise<string> =>
  await read(`packages/${manifest.name.replace("@stowage/", "")}/README.md`);

const published = [
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

/** Spec 16 gives `@stowage/conformance` a shape of its own and these ten the same sections. */
const sectioned = [
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
];

/** Spec 16: the sections a README carries, in this order, before anything else it holds. */
const packageSections = ["Install", "Example", "Runtimes", "Limits", "Notes", "Specification"];

test.each(sectioned)(
  "the README of $name carries the sections of spec 16 in order",
  async (manifest) => {
    const headings = headingsOf(await readmeOf(manifest));

    expect(headings.slice(0, packageSections.length)).toEqual(packageSections);
  },
);

test("the README of @stowage/conformance carries the shape spec 16 gives it", async () => {
  const text = await readmeOf(conformance);

  expect(text).toContain("describeConformance");
  expect(text).toContain("runAll");
  expect(text).toContain("`workerd`");
  expect(text).toContain("bun:test");
  expect(text).toContain("Deno.test");
  expect(text).toContain("[`@stowage/adapter-memory`]");
  expect(headingsOf(text)).toContain("Specification");
});

function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);

  if (start === -1) return "";

  const end = text.indexOf("\n## ", start + 1);

  return text.slice(start, end === -1 ? undefined : end);
}

test("the README of @stowage/conformance names the five adapters of this repository", async () => {
  const text = await readmeOf(conformance);

  for (const adapter of [adapterMemory, adapterFs, adapterS3, adapterAzureBlob, adapterGcs]) {
    expect(text).toContain(adapter.name);
  }
});

test("the README of @stowage/core covers the exports of spec 4.13", async () => {
  const text = await readmeOf(core);

  for (const name of [
    "invalidKeyReason",
    "errorCodeForStatus",
    "isTransientStatus",
    "withRetry",
    "parseXml",
    "XmlSyntaxError",
    "readEnvironment",
    "isUserMetadataKey",
    "encodeUserMetadataValue",
    "decodeUserMetadataValue",
    "userMetadataByteLength",
    "PresignedPut",
  ]) {
    expect(text).toContain(`\`${name}\``);
  }
});

test("the README of @stowage/adapter-azure-blob writes its example with an access token", async () => {
  const example = sectionOf(await readmeOf(adapterAzureBlob), "Example");

  expect(example).toContain("accessToken");
  expect(example).not.toContain("accountKey");
});

test("the README of @stowage/adapter-azure-blob names the limits of spec 16", async () => {
  const limits = sectionOf(await readmeOf(adapterAzureBlob), "Limits");

  expect(limits).toContain("`userMetadataTokenKeys` is not declared");
  expect(limits).toContain("#49-capabilities");
  expect(limits).toContain("254 segments");
  expect(limits).toContain("a segment ending in `.`");
  expect(limits).toContain("`U+0080` to `U+009F`");
  expect(limits).toContain("256 keys");
  expect(limits).toContain("#82-promised-provider");
});

// Spec 16 orders the notes of `adapter-azure-blob`; each marker is where one note first
// shows, so a note moved out of its place moves its marker past the next one.
test("the README of @stowage/adapter-azure-blob orders its notes as spec 16 does", async () => {
  const notes = sectionOf(await readmeOf(adapterAzureBlob), "Notes");
  const positions = [
    "getToken",
    "AZURE_STORAGE_KEY",
    "AccountName=",
    "CORS",
    "InvalidBlockList",
    "blob.stream()",
    "TransformStream",
  ].map((marker) => notes.indexOf(marker));

  expect(positions).not.toContain(-1);
  expect(positions).toEqual(positions.toSorted((left, right) => left - right));
});

test("the README of @stowage/adapter-gcs writes its example with an access token", async () => {
  const example = sectionOf(await readmeOf(adapterGcs), "Example");

  expect(example).toContain("accessToken");
  expect(example).not.toContain("privateKey");
});

test("the README of @stowage/adapter-gcs names the limits of spec 16", async () => {
  const limits = sectionOf(await readmeOf(adapterGcs), "Limits");

  expect(limits).toContain("`presignedUrls` is declared only with a `signer`");
  expect(limits).toContain("#49-capabilities");
  expect(limits).toContain("`.well-known/acme-challenge/`");
  expect(limits).toContain("`U+FFFE` or `U+FFFF`");
  expect(limits).toContain("100 keys");
  expect(limits).toContain("#91-construction");
  expect(limits).toContain("up to four");
  expect(limits).toContain("garbled");
  expect(limits).toContain("another prefix");
  expect(limits).toContain("#94-requests");
  expect(limits).toContain("#92-promised-provider");
});

// Spec 16 gives the notes of `adapter-gcs` an order of their own, held by the same markers.
test("the README of @stowage/adapter-gcs orders its notes as spec 16 does", async () => {
  const notes = sectionOf(await readmeOf(adapterGcs), "Notes");
  const positions = [
    "GoogleAuth",
    "forceRefresh",
    "nodejs_compat",
    "privateKey",
    "signBlob",
    "CORS",
    "blob.stream()",
    "TransformStream",
  ].map((marker) => notes.indexOf(marker));

  expect(positions).not.toContain(-1);
  expect(positions).toEqual(positions.toSorted((left, right) => left - right));
});

test("the README of @stowage/adapter-gcs names the scope a storage token needs", async () => {
  const notes = sectionOf(await readmeOf(adapterGcs), "Notes");

  expect(notes).toContain("https://www.googleapis.com/auth/devstorage.read_write");
});

// Spec 16 shows no key exchange: a token is acquired by the caller's library or resolver,
// never at Google's token endpoint in a block of this README.
test("the README of @stowage/adapter-gcs shows no key exchange", async () => {
  const text = await readmeOf(adapterGcs);

  expect(text).not.toContain("oauth2.googleapis.com");
  expect(text).not.toContain("urn:ietf:params:oauth:grant-type:jwt-bearer");
});

test("the README of @stowage/conformance shows how to test a server after `workerd`", async () => {
  const text = await readmeOf(conformance);
  const headings = headingsOf(text);
  const testAServer = sectionOf(text, "Test a server");

  expect(headings.indexOf("Test a server")).toBe(
    headings.indexOf("Run the cases on `workerd`") + 1,
  );
  expect(testAServer).toContain("HttpConformanceTarget");
  expect(testAServer).toContain("describeHttpConformance");
  expect(testAServer).toContain("[`@stowage/hono`]");
});

// Spec 16 has an empty section say so, and leaves limits empty for these two.
test.each([nestjs, hono])(
  "the README of $name says that its limits are empty",
  async (manifest) => {
    expect(sectionOf(await readmeOf(manifest), "Limits").trim()).toBe("## Limits\n\nThis section is empty.");
  },
);

test("the README of @stowage/http names the limit of spec 16", async () => {
  const limits = sectionOf(await readmeOf(http), "Limits");

  expect(limits).toContain("`redirectToObject`");
  expect(limits).toContain("`HEAD`");
  expect(limits).toContain("`403`");
  expect(limits).toContain("`serveObject`");
  expect(limits).toContain("#104-redirecting-to-an-object");
});

test("the README of @stowage/nextjs names the limit of spec 16", async () => {
  const limits = sectionOf(await readmeOf(nextjs), "Limits");

  expect(limits).toContain("`proxyClientMaxBodySize`");
  expect(limits).toContain("`matcher`");
  expect(limits).toContain("`maxSize`");
  expect(limits).toContain("#13-stowagenextjs");
});

/** What spec 16 has the example and the notes of each integration README show. */
const integrationContents = [
  {
    manifest: http,
    example: ["serveObject", "acceptUpload", "maxSize", '"GET"', '"HEAD"', '"PUT"'],
    notes: [
      "toWebRequest",
      "express",
      "reply.hijack()",
      "removeAllContentTypeParsers()",
      "bodyLimit",
      "maxRequestBodySize",
      "128 MiB",
      "TypeError",
    ],
  },
  {
    manifest: nestjs,
    example: [
      "StorageModule.forRoot({ provide",
      "@Inject(",
      "@Req()",
      "@Res()",
      "webRequestOf",
      "sendResponse",
    ],
    notes: [
      "removeAllContentTypeParsers()",
      'addContentTypeParser("*", (_req, _payload, done) => done(null))',
      "bodyLimit",
      "bodyParser: false",
      "forRootAsync",
      "inject:",
      "overrideProvider(",
    ],
  },
  {
    manifest: hono,
    example: ["withStorage(", "serveObject"],
    notes: [
      "Env",
      "c.env",
      "validator",
      "bodyLimit()",
      "etag()",
      "compress()",
      "128 MiB",
      "createApp",
    ],
  },
  {
    manifest: nextjs,
    example: ['import "server-only"', "lazyStorage(", "[...key]", "GET", "PUT"],
    notes: [
      "a%2Fb",
      "server action",
      "await connection()",
      "force-static",
      "revalidate",
      "'use cache'",
      "module graph",
      "vi.mock(",
    ],
  },
];

test.each(integrationContents)(
  "the README of $manifest.name shows the example and the notes of spec 16",
  async ({ manifest, example, notes }) => {
    const text = await readmeOf(manifest);

    for (const marker of example) expect(sectionOf(text, "Example")).toContain(marker);
    for (const marker of notes) expect(sectionOf(text, "Notes")).toContain(marker);
  },
);

type Dependencies = Readonly<Record<string, string | undefined>>;

const dependenciesOf = async (
  path: string,
  field: "devDependencies" | "peerDependencies",
): Promise<Dependencies> =>
  // oxlint-disable-next-line no-unsafe-type-assertion -- a manifest of this repository
  (JSON.parse(await read(path)) as Record<typeof field, Dependencies | undefined>)[field] ?? {};

/**
 * The framework whose peer range each integration declares, and the manifest that pins the
 * newest release CI runs it with, which Renovate moves.
 */
const integrations = [
  { manifest: nestjs, framework: "@nestjs/common", newest: "packages/nestjs/package.json" },
  { manifest: hono, framework: "hono", newest: "packages/hono/package.json" },
  { manifest: nextjs, framework: "next", newest: "harness/nextjs/package.json" },
];

// Spec 16: runtimes of an integration name the peer range, the floor and the newest version
// CI ran, which the floors harness and the package's own development install pin.
test.each(integrations)(
  "the README of $manifest.name names its peer range, its floor and the newest version CI ran",
  async ({ manifest, framework, newest }) => {
    const runtimes = sectionOf(await readmeOf(manifest), "Runtimes");
    const name = manifest.name.replace("@stowage/", "");
    const peerRange = (await dependenciesOf(`packages/${name}/package.json`, "peerDependencies"))[
      framework
    ];
    const floor = (await dependenciesOf("harness/floors/package.json", "devDependencies"))[
      framework
    ];
    const ran = (await dependenciesOf(newest, "devDependencies"))[framework];

    expect(runtimes).toContain(`\`${peerRange}\``);
    expect(runtimes).toContain(`floor is ${floor}`);
    expect(runtimes).toContain(`CI ran ${ran}`);
  },
);

test.each([http, nestjs, hono, nextjs])(
  "the README of $name links its cells of the second table of spec 2",
  async (manifest) => {
    const runtimes = sectionOf(await readmeOf(manifest), "Runtimes");

    expect(runtimes).toContain("#2-runtime-matrix");
    expect(runtimes).toContain("measures");
  },
);

test("the README of @stowage/nestjs names its cells on Express and on Fastify apart", async () => {
  const runtimes = sectionOf(await readmeOf(nestjs), "Runtimes");

  expect(runtimes).toContain("NestJS on Express");
  expect(runtimes).toContain("NestJS on Fastify");
});

test("the README of @stowage/http names the runtimes the Node bridge covers", async () => {
  expect(sectionOf(await readmeOf(http), "Runtimes")).toContain(
    "The Node bridge covers Node, Bun and Deno, and not `workerd`",
  );
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

// Spec 16 links the spec at the tag of the package's release, which changesets names
// `<name>@<version>`. The version the tag names is the release the README goes out with, so
// it is never older than the manifest's: a version bump that leaves the link behind fails
// here instead of sending a caller to promises an older release made. The links are written
// ahead of the version pull request, so the release is the newest version they name, and
// one link left at an earlier tag fails here as well.
test.each(published)(
  "the README of $name links the spec at the tag of its release",
  async (manifest) => {
    const text = await readmeOf(manifest);
    const links = [
      ...text.matchAll(
        /https:\/\/github\.com\/stowage-js\/stowage\/blob\/([^/]+\/[^/@]+)@([^/]+)\/docs\/spec\.md/gu,
      ),
    ].map(([, name = "", version = ""]) => ({ name, version }));

    expect(links.length).toBeGreaterThan(0);

    const release =
      links
        .map(({ version }) => version)
        .toSorted(compareVersions)
        .at(-1) ?? "";

    expect(compareVersions(release, manifest.version)).toBeGreaterThanOrEqual(0);

    for (const { name, version } of links) {
      expect(name).toBe(manifest.name);
      expect(version).toBe(release);
    }

    expect(text).not.toMatch(/stowage\/blob\/main\/docs\/spec\.md/u);
  },
);

const releaseLinkedBy = async (manifest: { readonly name: string }): Promise<string[]> => [
  ...new Set(
    [
      ...(await readmeOf(manifest)).matchAll(
        /https:\/\/github\.com\/stowage-js\/stowage\/blob\/[^/]+\/[^/@]+@([^/]+)\/docs\/spec\.md/gu,
      ),
    ].map(([, version = ""]) => version),
  ),
];

// Spec 1: the eleven packages carry one version number and are released together, so the
// READMEs link one release, a package joining the family among them.
test("every README links the spec at the same release", async () => {
  const releases = new Set((await Promise.all(published.map(releaseLinkedBy))).flat());

  expect([...releases]).toHaveLength(1);
});

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
    expect(text).toContain(`[\`${manifest.name}\`](packages/`);
  }

  expect(text).toContain("The eleven packages carry one version number");
});

// Spec 16: flow 1 stays a call sequence against a storage, and one sentence after it leads to
// the HTTP layer and the integrations, without a code block of its own.
test("the root README links the HTTP layer and the integrations after flow 1", async () => {
  const flow = sectionOf(await read("README.md"), "A large upload from a server");
  const afterExample = flow.slice(flow.lastIndexOf("```") + "```".length);

  expect(tsSourcesOf(flow)).toHaveLength(1);
  expect(afterExample).toContain("`acceptUpload`");

  for (const manifest of [http, nestjs, hono, nextjs]) {
    expect(afterExample).toContain(`(packages/${manifest.name.replace("@stowage/", "")})`);
  }
});
