import { type ConformanceFramework, describeCases } from "./describe.ts";
import { httpConformanceCases } from "./http-cases/index.ts";
import type { HttpConformanceTarget } from "./http-target.ts";
import { casesOfTier } from "./run.ts";

/**
 * Maps every HTTP case onto the framework as `describeConformance` maps the first list
 * (spec 14.8). There is no `runAll` beside it: the cases are client code, and on `workerd`
 * only the server runs inside the runtime.
 */
export function describeHttpConformance(
  target: HttpConformanceTarget,
  framework: ConformanceFramework,
): void {
  describeCases(
    casesOfTier(httpConformanceCases, framework),
    target,
    framework,
    `${target.name} over HTTP`,
  );
}
