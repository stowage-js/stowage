import type { HttpConformanceCase } from "../http-target.ts";
import { redirectCases } from "./redirect.ts";
import { serveCases } from "./serve.ts";

/** Spec 14.9, in its order. A case name is unique within this list, not across both. */
export const httpConformanceCases: readonly HttpConformanceCase[] = [
  ...serveCases,
  ...redirectCases,
];
