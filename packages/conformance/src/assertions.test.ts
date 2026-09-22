import { StorageError } from "@stowage/core";
import { expect, test } from "vitest";

import { expectUnsupported } from "./assertions.ts";

const unsupported = (capability: "rangeReads" | "userMetadata"): StorageError =>
  new StorageError({
    code: "Unsupported",
    message: `This storage does not declare \`${capability}\``,
    operation: "get",
    bucket: "stub",
    provider: "stub",
    attempts: 0,
    capability,
  });

const rejecting = (thrown: unknown) => async (): Promise<never> => {
  throw thrown;
};

test("passes a call rejecting with `Unsupported` for the capability", async () => {
  await expect(
    expectUnsupported(rejecting(unsupported("rangeReads")), "rangeReads"),
  ).resolves.toBeUndefined();
});

test("refuses a call that resolves", async () => {
  await expect(expectUnsupported(async () => "done", "rangeReads")).rejects.toThrow(
    "the call resolved",
  );
});

test("refuses a rejection that is no `StorageError`", async () => {
  await expect(
    expectUnsupported(rejecting(new TypeError("something else")), "rangeReads"),
  ).rejects.toThrow("the call threw TypeError: something else");
});

test("refuses a `StorageError` carrying another code", async () => {
  const other = new StorageError({
    code: "NotFound",
    message: "No object under the key",
    operation: "get",
    bucket: "stub",
    provider: "stub",
    attempts: 1,
  });

  await expect(expectUnsupported(rejecting(other), "rangeReads")).rejects.toThrow("`NotFound`");
});

test("refuses `Unsupported` naming another capability", async () => {
  await expect(
    expectUnsupported(rejecting(unsupported("userMetadata")), "rangeReads"),
  ).rejects.toThrow("naming `userMetadata`");
});
