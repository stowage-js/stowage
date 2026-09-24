import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import { runCases } from "../../../packages/conformance/src/run-all.ts";
import { selectedCases } from "../../../packages/conformance/src/run.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";
import { storageOptionsFrom, type Variables } from "../../s3/src/configuration.ts";
import { s3Target } from "../../s3/src/target.ts";
import { memoryTarget } from "../../targets/src/memory.ts";
import { runOptionsFrom } from "../../targets/src/run-options.ts";
import { excludedCases } from "./excluded.ts";

interface Run {
  readonly target: ConformanceTarget;
  readonly cases: readonly ConformanceCaseSource[];
}

// `workerd` has no test framework, so the worker runs one target per request through what
// `runAll` runs, less the exclusion, and answers with the results for Node to report.
export default {
  async fetch(request: Request, variables: Variables): Promise<Response> {
    const url = new URL(request.url);
    const run = runAt(url.pathname, variables);

    if (run === undefined) return new Response(null, { status: 404 });

    const cases = run.cases.filter((source) => !excludedCases.includes(source.name));

    return Response.json(await runCases(cases, run.target));
  },
};

function runAt(pathname: string, variables: Variables): Run | undefined {
  const cases = selectedCases(runOptionsFrom(variables));

  if (pathname === "/adapter-memory") return { target: memoryTarget, cases };
  if (pathname !== "/adapter-s3") return undefined;

  // The worker runs without `nodejs_compat`, where `fromEnv` finds no `process` to read,
  // so the credential arrives as two bindings like the rest of the endpoint.
  const configured = storageOptionsFrom(variables, {
    accessKeyId: variables["AWS_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: variables["AWS_SECRET_ACCESS_KEY"] ?? "",
  });

  if (configured === undefined) return undefined;

  return { target: s3Target(configured, variables), cases };
}
