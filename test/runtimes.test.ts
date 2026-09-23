import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

const read = async (path: string): Promise<string> =>
  await readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the `workerd` harness pins the compatibility date of spec 1", async () => {
  expect(await read("harness/workerd/workerd.capnp")).toContain(
    'compatibilityDate = "2026-09-01"',
  );
});
