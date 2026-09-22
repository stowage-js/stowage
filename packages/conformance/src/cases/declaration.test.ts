import { capabilityNames, type Storage } from "@stowage/core";
import { expect, test } from "vitest";

import { startRun } from "../run.ts";
import { caseNamed, stubStorage, stubTarget } from "../stubs.ts";

const against = async (storage: Storage, name: string): Promise<void> => {
  const context = await startRun(stubTarget({ createStorage: () => storage }), "conformance/");

  await caseNamed(name).run(context);
};

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
