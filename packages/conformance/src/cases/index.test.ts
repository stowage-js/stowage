import { expect, test } from "vitest";

import { conformanceCases, conformanceCaseSources } from "./index.ts";

type SpecifiedCase = readonly [name: string, requires: readonly string[], cost: string];

/** The rows of spec 8.5 the suite holds, in the order the spec lists them. */
const specified: readonly SpecifiedCase[] = [
  ["declaration/valid-names", [], "fast"],
  ["declaration/identity", [], "fast"],
  ["put/bytes-round-trip", [], "fast"],
  ["put/string-round-trip", [], "fast"],
  ["put/stream-round-trip", [], "fast"],
  ["put/multipart-round-trip", [], "fast"],
  ["put/empty-body", [], "fast"],
  ["put/overwrites", [], "fast"],
  ["put/content-type-stored", [], "fast"],
  ["put/content-type-default", [], "fast"],
  ["put/accepted-keys", [], "fast"],
  ["put/refused-keys", [], "fast"],
  ["put/unknown-option", [], "fast"],
  ["put/aborted-signal", [], "fast"],
  ["put/abort-during-upload", [], "fast"],
  ["put/stream-consumed", [], "fast"],
  ["put/user-metadata", ["userMetadata"], "fast"],
  ["put/user-metadata-limits", ["userMetadata"], "fast"],
  ["get/missing-key", [], "fast"],
  ["get/stream", [], "fast"],
  ["get/text-and-json", [], "fast"],
  ["get/body-read-once", [], "fast"],
  ["get/stat-from-response", [], "fast"],
  ["get/addressable-keys", [], "fast"],
  ["get/aborted-signal", [], "fast"],
  ["get/range", ["rangeReads"], "fast"],
  ["get/range-unsatisfiable", ["rangeReads"], "fast"],
  ["get/range-clipped", ["rangeReads"], "fast"],
  ["stat/describes-object", [], "fast"],
  ["stat/missing-key", [], "fast"],
  ["exists/answers", [], "fast"],
  ["exists/invalid-key", [], "fast"],
  ["list/nothing", [], "fast"],
  ["list/every-object-once", [], "fast"],
  ["list/entry-shape", [], "fast"],
  ["list/pages-and-cursor", [], "fast"],
  ["list/delimiter", [], "fast"],
  ["list/prefix-mid-segment", [], "fast"],
  ["list/lazy", [], "fast"],
  ["list/page-size-bounds", [], "fast"],
  ["list/invalid-cursor", [], "fast"],
  ["list/invalid-delimiter", [], "fast"],
  ["list/past-one-thousand", [], "slow"],
  ["list/key-bytes", ["keyBytesPreserved"], "fast"],
  ["delete/single", [], "fast"],
  ["delete/many", [], "fast"],
  ["delete/absent-key-succeeds", [], "fast"],
  ["delete/nothing", [], "fast"],
  ["delete/invalid-key-reported", [], "fast"],
  ["delete/past-one-thousand", [], "slow"],
  ["deleteAll/below-prefix", [], "fast"],
  ["deleteAll/nothing", [], "fast"],
  ["deleteAll/past-one-thousand", [], "slow"],
  ["copy/round-trip", [], "fast"],
  ["copy/overwrites", [], "fast"],
  ["copy/missing-source", [], "fast"],
  ["copy/onto-itself", [], "fast"],
  ["copy/invalid-keys", [], "fast"],
  ["copy/user-metadata", ["userMetadata"], "fast"],
  ["move/round-trip", [], "fast"],
  ["move/missing-source", [], "fast"],
  ["errors/shape", [], "fast"],
  ["errors/not-a-storage-error", [], "fast"],
  ["errors/bad-credentials", [], "fast"],
  ["errors/denied-credentials", [], "fast"],
  ["errors/expired-credentials", [], "slow"],
  ["presign/get", ["presignedUrls"], "fast"],
  ["presign/put", ["presignedUrls"], "fast"],
  ["presign/expires-in-bounds", ["presignedUrls"], "fast"],
  ["presign/put-rejects-type", ["presignedUrls"], "slow"],
  ["presign/put-rejects-length", ["presignedUrls"], "slow"],
  ["presign/expired-url", ["presignedUrls"], "slow"],
];

test("the suite holds the cases of spec 8.5, each with the requirement and the cost of its row", () => {
  const held = conformanceCaseSources.map((source): SpecifiedCase => [
    source.name,
    source.requires,
    source.cost,
  ]);

  expect(held).toEqual(specified);
});

test("every case naming a capability carries the `runWithout` half of its row", () => {
  for (const source of conformanceCaseSources.filter((one) => one.requires.length > 0)) {
    expect(source).toHaveProperty("runWithout", expect.any(Function));
  }
});

test("the cases hanging on a credential factory of spec 8.3 name the one their row marks", () => {
  const marked = conformanceCaseSources
    .filter((source) => source.factory !== undefined)
    .map((source) => [source.name, source.factory]);

  expect(marked).toEqual([
    ["errors/bad-credentials", "createStorageWithBadCredentials"],
    ["errors/denied-credentials", "createStorageWithDeniedCredentials"],
    ["errors/expired-credentials", "createStorageWithExpiredCredentials"],
  ]);
});

test("no two cases share a name", () => {
  // Spec 8.5: names are stable, so a renamed case is a removed one and an added one.
  const names = conformanceCases.map((source) => source.name);

  expect(new Set(names).size).toBe(names.length);
});
