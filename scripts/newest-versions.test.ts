import { expect, test } from "vitest";

import { withNewestVersion } from "./newest-versions.ts";

test("names the newest version in place of the one CI ran before", () => {
  const readme = "and at this release CI ran 4.13.12 as the newest release of Hono 4.";

  expect(withNewestVersion(readme, "4.13.13")).toBe(
    "and at this release CI ran 4.13.13 as the newest release of Hono 4.",
  );
});

test("keeps the line break the README wraps the sentence at", () => {
  const readme = "and at this release CI\nran 12.1.2 as the newest release of NestJS 12.";

  expect(withNewestVersion(readme, "12.2.0")).toBe(
    "and at this release CI\nran 12.2.0 as the newest release of NestJS 12.",
  );
});

test("refuses a README that names no version CI ran", () => {
  expect(() => withNewestVersion("CI last ran green on Bun 1.4.2.", "4.13.13")).toThrow(
    "names no version CI ran",
  );
});
