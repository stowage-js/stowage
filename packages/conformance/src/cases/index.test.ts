import { expect, test } from "vitest";

import { conformanceCases, conformanceCaseSources } from "./index.ts";

test("the suite holds the declaration cases of spec 8.5, each `fast` and needing nothing", () => {
  expect(conformanceCaseSources.map((source) => source.name)).toEqual([
    "declaration/valid-names",
    "declaration/identity",
  ]);

  for (const source of conformanceCaseSources) {
    expect(source.requires).toEqual([]);
    expect(source.cost).toBe("fast");
  }
});

test("no two cases share a name", () => {
  // Spec 8.5: names are stable, so a renamed case is a removed one and an added one.
  const names = conformanceCases.map((source) => source.name);

  expect(new Set(names).size).toBe(names.length);
});
