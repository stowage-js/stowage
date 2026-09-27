import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import { runCases } from "../../../packages/conformance/src/run-all.ts";
import {
  type ConformanceRunOptions,
  selectedCases,
} from "../../../packages/conformance/src/run.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";
import {
  endpointNameFrom as azureBlobEndpointNameFrom,
  storageOptionsFrom as azureBlobStorageOptionsFrom,
} from "../../azure-blob/src/configuration.ts";
import { withAzureBlobDivergences } from "../../azure-blob/src/divergences.ts";
import { azureBlobCases, azureBlobTarget } from "../../azure-blob/src/target.ts";
import { mintAccessToken } from "../../azure-blob/src/token.ts";
import {
  endpointNameFrom,
  storageOptionsFrom,
  type Variables,
} from "../../s3/src/configuration.ts";
import { withDivergences } from "../../s3/src/divergences.ts";
import { s3Target } from "../../s3/src/target.ts";
import { runCoreChecks } from "../../targets/src/core.ts";
import { memoryTarget } from "../../targets/src/memory.ts";
import { runOptionsFrom } from "../../targets/src/run-options.ts";
import { fromEnvOutcome } from "./from-env.ts";
import { nodeApiReach } from "./node-api.ts";

interface Run {
  readonly target: ConformanceTarget;
  readonly cases: readonly ConformanceCaseSource[];
}

// `workerd` has no test framework, so the worker runs one target per request through what
// `runAll` runs and answers with the results for Node to report.
export default {
  async fetch(request: Request, variables: Variables): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/core") return Response.json(runCoreChecks());
    if (url.pathname === "/node-api") return Response.json(await nodeApiReach());
    if (url.pathname === "/from-env") return Response.json(fromEnvOutcome());

    const run = runAt(url.pathname, variables);

    if (run === undefined) return new Response(null, { status: 404 });

    return Response.json(await runCases(run.cases, run.target));
  },
};

function runAt(pathname: string, variables: Variables): Run | undefined {
  const options = runOptionsFrom(variables);
  const cases = selectedCases(options);

  if (pathname === "/adapter-memory") return { target: memoryTarget, cases };
  if (pathname === "/adapter-azure-blob") return azureBlobRun(variables, options);
  if (pathname !== "/adapter-s3") return undefined;

  // The flags of spec 1 take `process` away, so `fromEnv` finds nothing to read here and
  // the credential arrives as two bindings like the rest of the endpoint.
  const configured = storageOptionsFrom(variables, {
    accessKeyId: variables["AWS_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: variables["AWS_SECRET_ACCESS_KEY"] ?? "",
  });

  if (configured === undefined) return undefined;

  return {
    target: s3Target(configured, variables),
    cases: withDivergences(cases, endpointNameFrom(variables)),
  };
}

function azureBlobRun(variables: Variables, options: ConformanceRunOptions): Run | undefined {
  // ADR 0023: the suite runs under an access token and not the account key `fromEnv`
  // reads, so the worker mints one for every request as the other harnesses do.
  const configured = azureBlobStorageOptionsFrom(variables, () => ({
    accessToken: mintAccessToken(),
  }));

  if (configured === undefined) return undefined;

  return {
    target: azureBlobTarget(configured),
    cases: withAzureBlobDivergences(azureBlobCases(options), azureBlobEndpointNameFrom(variables)),
  };
}
