import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile } from "node:fs/promises";
import { get, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";

import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import type { ConformanceResult } from "../../../packages/conformance/src/result.ts";
import { configuredStorage as configuredAzureBlobStorage } from "../../azure-blob/src/environment.ts";
import { describeAzureBlobEndpointCheck } from "../../azure-blob/src/target.ts";
import { configuredStorage } from "../../s3/src/environment.ts";
import { describeEndpointCheck } from "../../s3/src/target.ts";
import { type CoreCheckResult, describeCoreResults } from "../../targets/src/core.ts";
import type { FromEnvOutcome } from "./from-env.ts";
import type { NodeApiReach } from "./node-api.ts";

const harnessDirectory = fileURLToPath(new URL("..", import.meta.url));

/**
 * ADR 0006: `workerd` has no test function to hand the cases to, so the worker runs them
 * and answers with the results, and the harness reports each one on Node as a test of its
 * own, named as `describeConformance` names the case. What each worker reports about
 * itself beside the cases is handed back for the caller to assert on.
 */
export async function describeWorkerd(
  framework: ConformanceFramework,
): Promise<Record<Socket, Probes>> {
  await bundleWorker();
  await placeTrustedCertificate();

  const configured = configuredStorage();
  const configuredAzureBlob = configuredAzureBlobStorage();

  const { core, memory, s3, azureBlob, probes } = await withWorkerd(async (origins) => ({
    core: await answerOf<readonly CoreCheckResult[]>(origins.harness, "core"),
    memory: await resultsOf(origins.harness, "adapter-memory"),
    s3: configured === undefined ? undefined : await resultsOf(origins.harness, "adapter-s3"),
    azureBlob:
      configuredAzureBlob === undefined
        ? undefined
        : {
            harness: await resultsOf(origins.harness, "adapter-azure-blob"),
            defaults: await resultsOf(origins.defaults, "adapter-azure-blob"),
          },
    probes: {
      harness: await probesOf(origins.harness),
      defaults: await probesOf(origins.defaults),
    },
  }));

  describeCoreResults(framework, core);

  describeResults(framework, "@stowage/adapter-memory", memory);

  describeEndpointCheck(framework, configured);

  if (s3 !== undefined) describeResults(framework, "@stowage/adapter-s3", s3);

  describeAzureBlobEndpointCheck(framework, configuredAzureBlob);

  if (azureBlob !== undefined) {
    describeResults(framework, "@stowage/adapter-azure-blob", azureBlob.harness);
    describeResults(
      framework,
      "@stowage/adapter-azure-blob at the default flags",
      azureBlob.defaults,
    );
  }

  return probes;
}

/**
 * The sockets of `workerd.capnp`: `harness` reaches the worker at the flags of spec 1,
 * `defaults` the same module at the defaults its compatibility date turns on.
 */
const sockets = ["harness", "defaults"] as const;

export type Socket = (typeof sockets)[number];

/** What one worker answers about itself beside the cases. */
export interface Probes {
  readonly nodeApi: NodeApiReach;
  readonly fromEnv: FromEnvOutcome;
}

/** `src/worker.ts` as the one module `workerd.capnp` embeds. */
async function bundleWorker(): Promise<void> {
  await build({
    config: false,
    cwd: harnessDirectory,
    entry: { worker: "src/worker.ts" },
    outDir: "dist",
    format: "esm",
    platform: "neutral",
    fixedExtension: false,
    dts: false,
    logLevel: "warn",
  });
}

/**
 * ADR 0023: `workerd.capnp` trusts the certificate `harness/azure-blob/start.sh` generates,
 * and `workerd` refuses to start on a missing or empty file. Where no Azurite was started, a
 * certificate whose key nobody holds stands in, so that the run reports the missing endpoint
 * as a failed check (ADR 0012) and the other adapters' results still arrive.
 */
async function placeTrustedCertificate(): Promise<void> {
  const trusted = join(harnessDirectory, "dist", "trusted-certificate.pem");

  try {
    await copyFile(join(harnessDirectory, "..", "azure-blob", "certificate", "cert.pem"), trusted);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;

    await copyFile(join(harnessDirectory, "placeholder-certificate.pem"), trusted);
  }
}

async function withWorkerd<T>(use: (origins: Record<Socket, string>) => Promise<T>): Promise<T> {
  // The package hands out the path of the binary built for this machine as its default
  // export.
  const workerd: { readonly default: string } = createRequire(import.meta.url)("workerd");

  const child = spawn(workerd.default, ["serve", "workerd.capnp", "--control-fd=3"], {
    cwd: harnessDirectory,
    stdio: ["ignore", "inherit", "inherit", "pipe"],
  });
  const exited = once(child, "exit").catch(() => {});

  try {
    const ports = await listeningPorts(child);

    return await use({
      harness: `http://127.0.0.1:${ports.harness}`,
      defaults: `http://127.0.0.1:${ports.defaults}`,
    });
  } finally {
    child.kill();
    await exited;
  }
}

/** The ports `workerd` reports on the control descriptor once both sockets listen. */
async function listeningPorts(child: ChildProcess): Promise<Record<Socket, number>> {
  const [, , , control] = child.stdio;

  if (!(control instanceof Readable)) throw new Error("`workerd` has no control descriptor");

  const ports = new Map<Socket, number>();

  for await (const line of createInterface({ input: control })) {
    const message: {
      readonly event?: unknown;
      readonly socket?: unknown;
      readonly port?: unknown;
    } = JSON.parse(line);

    if (
      message.event === "listen" &&
      isSocket(message.socket) &&
      typeof message.port === "number"
    ) {
      ports.set(message.socket, message.port);
    }

    const harness = ports.get("harness");
    const defaults = ports.get("defaults");

    if (harness !== undefined && defaults !== undefined) return { harness, defaults };
  }

  throw new Error("`workerd` exited before its sockets listened");
}

function isSocket(value: unknown): value is Socket {
  return sockets.some((socket) => socket === value);
}

/**
 * Through `node:http` rather than `fetch`: the worker answers once the last case ran, and
 * Node's `fetch` gives up on a response whose headers take five minutes, which a run
 * against a real bucket outlasts.
 */
async function resultsOf(origin: string, path: string): Promise<readonly ConformanceResult[]> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(`${origin}/${path}`, resolve).on("error", reject);
  });
  const body = await text(response);

  if (response.statusCode !== 200) {
    throw new Error(`The worker answered ${response.statusCode} for ${path}`);
  }

  const results: readonly ConformanceResult[] = JSON.parse(body);

  return results;
}

async function probesOf(origin: string): Promise<Probes> {
  return {
    nodeApi: await answerOf<NodeApiReach>(origin, "node-api"),
    fromEnv: await answerOf<FromEnvOutcome>(origin, "from-env"),
  };
}

async function answerOf<T>(origin: string, path: string): Promise<T> {
  const response = await fetch(`${origin}/${path}`);

  if (!response.ok) throw new Error(`The worker answered ${response.status} for ${path}`);

  const answer: T = await response.json();

  return answer;
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
