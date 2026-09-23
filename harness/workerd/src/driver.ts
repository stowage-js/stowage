import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";

import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import type { ConformanceResult } from "../../../packages/conformance/src/result.ts";
import { configuredStorage, endpointMissing } from "../../s3/src/environment.ts";
import { endpointConfiguredTest } from "../../s3/src/target.ts";

const harness = fileURLToPath(new URL("..", import.meta.url));

/**
 * ADR 0006: `workerd` has no test function to hand the cases to, so the worker runs them
 * and answers with the results, and this driver, running on Node, reports each one as a
 * test of its own, named as `describeConformance` names the case.
 */
export async function describeWorkerd(framework: ConformanceFramework): Promise<void> {
  await bundleWorker();

  const configured = configuredStorage();

  const { memory, s3 } = await withWorkerd(async (origin) => ({
    memory: await resultsOf(origin, "adapter-memory"),
    s3: configured === undefined ? undefined : await resultsOf(origin, "adapter-s3"),
  }));

  describeResults(framework, "@stowage/adapter-memory", memory);

  framework.test(endpointConfiguredTest, async () => {
    if (configured === undefined) throw new Error(endpointMissing);
  });

  if (s3 !== undefined) describeResults(framework, "@stowage/adapter-s3", s3);
}

/** `src/worker.ts` as the one module `workerd.capnp` embeds. */
async function bundleWorker(): Promise<void> {
  await build({
    config: false,
    cwd: harness,
    entry: { worker: "src/worker.ts" },
    outDir: "dist",
    format: "esm",
    platform: "neutral",
    fixedExtension: false,
    dts: false,
    logLevel: "warn",
  });
}

async function withWorkerd<T>(use: (origin: string) => Promise<T>): Promise<T> {
  // The package hands out the path of its platform binary as its default export.
  const workerd: { readonly default: string } = createRequire(import.meta.url)("workerd");

  const child = spawn(workerd.default, ["serve", "workerd.capnp", "--control-fd=3"], {
    cwd: harness,
    stdio: ["ignore", "inherit", "inherit", "pipe"],
  });

  try {
    return await use(`http://127.0.0.1:${await listeningPort(child)}`);
  } finally {
    child.kill();
    await once(child, "exit");
  }
}

/** The port `workerd` reports on the control descriptor once its socket listens. */
async function listeningPort(child: ChildProcess): Promise<number> {
  const [, , , control] = child.stdio;

  if (!(control instanceof Readable)) throw new Error("`workerd` has no control descriptor");

  for await (const line of createInterface({ input: control })) {
    const message: { readonly event?: unknown; readonly port?: unknown } = JSON.parse(line);

    if (message.event === "listen" && typeof message.port === "number") return message.port;
  }

  throw new Error("`workerd` exited before its socket listened");
}

async function resultsOf(origin: string, adapter: string): Promise<readonly ConformanceResult[]> {
  const response = await fetch(`${origin}/${adapter}`);

  if (!response.ok) throw new Error(`The worker answered ${response.status} for ${adapter}`);

  const results: readonly ConformanceResult[] = await response.json();

  return results;
}

function describeResults(
  framework: ConformanceFramework,
  name: string,
  results: readonly ConformanceResult[],
): void {
  framework.describe(name, () => {
    for (const result of results) {
      if (result.status === "skipped") {
        framework.test(`${result.case.name} (skipped: ${result.reason})`, async () => {});
        continue;
      }

      framework.test(result.case.name, async () => {
        if (result.status === "failed") throw Object.assign(new Error(), result.error);
      });
    }
  });
}
