import { expect, test } from "vitest";

import { conformanceCaseSources } from "../../../packages/conformance/src/cases/index.ts";
import { gcsDivergences } from "./divergences.ts";

// ADR 0012: the types hold the endpoints; the name of the case is what they cannot.
test("every entry names a case of the suite", () => {
  const names = conformanceCaseSources.map((source) => source.name);

  for (const divergence of gcsDivergences) expect(names).toContain(divergence.case);
});
