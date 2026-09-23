import { runCases } from "../../../packages/conformance/src/run-all.ts";
import { selectedCases } from "../../../packages/conformance/src/run.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";
import { storageOptionsFrom, type Variables } from "../../s3/src/configuration.ts";
import { s3Target } from "../../s3/src/target.ts";
import { memoryTarget } from "../../targets/src/memory.ts";

/**
 * ADR 0006: flow 1 on `workerd` is one named exclusion in this harness, and the multipart
 * round trip of ADR 0016 joins it. Spec 12 leaves open what CPU and duration a multipart
 * upload spends here, which decides the cell; neither case names a runtime itself.
 */
const excludedCases: ReadonlySet<string> = new Set([
  "flow/1-large-upload",
  "put/multipart-round-trip",
]);

const cases = selectedCases().filter((source) => !excludedCases.has(source.name));

// `workerd` has no test framework, so the worker runs one target per request through the
// runner behind `runAll` and answers with the results, which the driver reports.
export default {
  async fetch(request: Request, variables: Variables): Promise<Response> {
    const target = targetAt(new URL(request.url).pathname, variables);

    if (target === undefined) return new Response(null, { status: 404 });

    return Response.json(await runCases(cases, target));
  },
};

function targetAt(pathname: string, variables: Variables): ConformanceTarget | undefined {
  if (pathname === "/adapter-memory") return memoryTarget;
  if (pathname !== "/adapter-s3") return undefined;

  // The worker runs without `nodejs_compat`, where `fromEnv` finds no `process` to read,
  // so the credential arrives as two bindings like the rest of the endpoint.
  const configured = storageOptionsFrom(variables, {
    accessKeyId: variables["AWS_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: variables["AWS_SECRET_ACCESS_KEY"] ?? "",
  });

  return configured === undefined ? undefined : s3Target(configured, variables);
}
