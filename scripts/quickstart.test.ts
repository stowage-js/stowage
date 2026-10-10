import { expect, test } from "vitest";

import { packagesOfInstallLine, quickstartOf, withStowageDependencies } from "./quickstart.ts";

const readme = [
  "# stowage",
  "",
  "```sh",
  "npm install @stowage/adapter-fs @stowage/adapter-s3",
  "```",
  "",
  "```ts",
  'import { fsStorage } from "@stowage/adapter-fs";',
  "",
  'const storage = fsStorage({ root: "/var/lib/my-app/storage" });',
  "```",
  "",
  "```ts",
  'import { s3Storage } from "@stowage/adapter-s3";',
  "```",
  "",
].join("\n");

test("reads the packages the install line names", () => {
  expect(packagesOfInstallLine(readme)).toEqual(["@stowage/adapter-fs", "@stowage/adapter-s3"]);
});

test("refuses a README without an install line", () => {
  expect(() => packagesOfInstallLine("# stowage\n")).toThrow("names no `npm install` line");
});

test("takes the first block and points its root at the directory given", () => {
  expect(quickstartOf(readme, "/tmp/quickstart/storage")).toBe(
    'import { fsStorage } from "@stowage/adapter-fs";\n\nconst storage = fsStorage({ root: "/tmp/quickstart/storage" });\n',
  );
});

test("refuses a first block that names no root", () => {
  expect(() => quickstartOf("```ts\nconst storage = memoryStorage();\n```\n", "/tmp")).toThrow(
    "names no `root`",
  );
});

const dependencies: Readonly<Record<string, readonly string[]>> = {
  "@stowage/adapter-fs": ["@stowage/core"],
  "@stowage/nestjs": ["@stowage/core", "@stowage/http"],
  "@stowage/http": ["@stowage/core"],
  "@stowage/core": [],
};

const dependenciesOf = (name: string): readonly string[] => dependencies[name] ?? [];

test("adds the stowage packages each named package depends on", () => {
  expect(
    withStowageDependencies(["@stowage/adapter-fs", "@stowage/nestjs"], dependenciesOf),
  ).toEqual(["@stowage/adapter-fs", "@stowage/core", "@stowage/http", "@stowage/nestjs"]);
});
