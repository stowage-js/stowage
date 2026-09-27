import { env } from "node:process";

import { endpointNameFrom as azureBlobEndpointNameFrom } from "../../azure-blob/src/configuration.ts";
import { configuredStorage as configuredAzureBlobStorage } from "../../azure-blob/src/environment.ts";
import { describeAzureBlob } from "../../azure-blob/src/target.ts";
import { endpointNameFrom } from "../../s3/src/configuration.ts";
import { withDivergences } from "../../s3/src/divergences.ts";
import { configuredStorage } from "../../s3/src/environment.ts";
import { describeEndpointCheck, s3Target } from "../../s3/src/target.ts";
import {
  type ConformanceFramework,
  describeCases,
  describeConformance,
} from "../../../packages/conformance/src/describe.ts";
import { selectedCases } from "../../../packages/conformance/src/run.ts";
import { describeCore } from "./core.ts";
import { fsCases, fsTarget } from "./fs.ts";
import { memoryTarget } from "./memory.ts";
import { runOptionsFrom } from "./run-options.ts";

/**
 * The core's checks, then the tiers the run asks for against the four adapters spec 2
 * names for Node, Bun and Deno. The columns share them whole, and a harness differs from
 * the next in the framework it hands over and nothing else, which is what keeps runtime
 * detection out of the cases.
 */
export function describeAdapters(framework: ConformanceFramework): void {
  const options = runOptionsFrom(env);

  describeCore(framework);

  // ADR 0006: `adapter-memory` is read against the suite like any other adapter, through
  // the same entry point a third-party harness calls.
  describeConformance(memoryTarget, { ...framework, ...options });

  describeCases(fsCases(options), fsTarget, framework);

  const configured = configuredStorage();

  describeEndpointCheck(framework, configured);

  if (configured !== undefined) {
    describeCases(
      withDivergences(selectedCases(options), endpointNameFrom(env)),
      s3Target(configured, env),
      framework,
    );
  }

  describeAzureBlob(
    { ...framework, ...options },
    configuredAzureBlobStorage(),
    azureBlobEndpointNameFrom(env),
  );
}
