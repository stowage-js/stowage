import type { ConformanceCase, ConformanceCaseSource } from "../case.ts";
import { declarationCases } from "./declaration.ts";
import { deleteCases } from "./delete.ts";
import { existsCases } from "./exists.ts";
import { getCases } from "./get.ts";
import { listCases } from "./list.ts";
import { putCases } from "./put.ts";
import { statCases } from "./stat.ts";

export const conformanceCaseSources: readonly ConformanceCaseSource[] = [
  ...declarationCases,
  ...putCases,
  ...getCases,
  ...statCases,
  ...existsCases,
  ...listCases,
  ...deleteCases,
];

/** The same cases as the package publishes them, without the factory of spec 8.3. */
export const conformanceCases: readonly ConformanceCase[] = conformanceCaseSources;
