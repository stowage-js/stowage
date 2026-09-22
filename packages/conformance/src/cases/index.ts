import type { ConformanceCase, ConformanceCaseSource } from "../case.ts";
import { declarationCases } from "./declaration.ts";
import { getCases } from "./get.ts";
import { putCases } from "./put.ts";

export const conformanceCaseSources: readonly ConformanceCaseSource[] = [
  ...declarationCases,
  ...putCases,
  ...getCases,
];

/** The same cases as the package publishes them, without the factory of spec 8.3. */
export const conformanceCases: readonly ConformanceCase[] = conformanceCaseSources;
