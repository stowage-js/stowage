import { expect, test } from "vitest";

import manifest from "../package.json" with { type: "json" };
import { packageName } from "./index.ts";

test("names the package it is published under", () => {
  expect(packageName).toBe(manifest.name);
});
