import { describe, expect, test } from "vitest";

import { conformanceCaseSources } from "../../../packages/conformance/src/cases/index.ts";
import { azureBlobDivergences } from "./divergences.ts";

// ADR 0012: the types hold the endpoints; the name of the case is what they cannot.
describe.each(azureBlobDivergences)("the entry for $case against $endpoint", (divergence) => {
  test("names a case of the suite", () => {
    expect(conformanceCaseSources.map((source) => source.name)).toContain(divergence.case);
  });
});
