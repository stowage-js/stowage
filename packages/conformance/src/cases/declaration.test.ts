import { capabilityNames, type Storage } from "@stowage/core";
import { expect, test } from "vitest";

import type { ConformanceCaseSource } from "../case.ts";
import { startRun } from "../run.ts";
import { stubStorage } from "../stub-storage.ts";
import { conformanceCaseSources } from "./index.ts";

const caseNamed = (name: string): ConformanceCaseSource => {
  const source = conformanceCaseSources.find((one) => one.name === name);

  if (source === undefined) throw new Error(`The suite holds no case named ${name}`);

  return source;
};

const against = async (storage: Storage, name: string): Promise<void> => {
  const context = await startRun({ name: "stub", createStorage: () => storage }, "conformance/");

  await caseNamed(name).run(context);
};

test("the suite holds the two declaration cases as `fast` cases needing nothing", () => {
  expect(conformanceCaseSources.map((source) => source.name)).toEqual([
    "declaration/valid-names",
    "declaration/identity",
  ]);

  for (const source of conformanceCaseSources) {
    expect(source.requires).toEqual([]);
    expect(source.cost).toBe("fast");
  }
});

test("`declaration/valid-names` passes a storage declaring every published name", async () => {
  await expect(
    against(stubStorage({ capabilities: capabilityNames }), "declaration/valid-names"),
  ).resolves.toBeUndefined();
});

test("`declaration/valid-names` refuses a name that is no capability name", async () => {
  await expect(
    against(stubStorage({ capabilities: ["rangeReads", "teleports"] }), "declaration/valid-names"),
  ).rejects.toThrow('"teleports"');
});

test("`declaration/valid-names` refuses a name declared twice", async () => {
  await expect(
    against(stubStorage({ capabilities: ["rangeReads", "rangeReads"] }), "declaration/valid-names"),
  ).rejects.toThrow("twice");
});

test("`declaration/identity` passes a storage naming its provider and its bucket", async () => {
  await expect(
    against(stubStorage({ provider: "memory", bucket: "memory" }), "declaration/identity"),
  ).resolves.toBeUndefined();
});

test.each(["provider", "bucket"])("`declaration/identity` refuses an empty %s", async (field) => {
  await expect(against(stubStorage({ [field]: "" }), "declaration/identity")).rejects.toThrow(
    `\`${field}\` is ""`,
  );
});
