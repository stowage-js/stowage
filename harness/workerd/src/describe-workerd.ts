import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { get, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";

import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import type { ConformanceResult } from "../../../packages/conformance/src/result.ts";
import { configuredStorage } from "../../s3/src/environment.ts";
import { describeEndpointCheck } from "../../s3/src/target.ts";
import type { NodeApiReach } from "./node-api.ts";

const harnessDirectory = fileURLToPath(new URL("..", import.meta.url));

/**
 * ADR 0006: `workerd` has no test function to hand the cases to, so the worker runs them
 * and answers with the results, and the harness reports each one on Node as a test of its
 * own, named as `describeConformance` names the case.
 */
export async function describeWorkerd(framework: ConformanceFramework): Promise<WorkerdProbes> {
  await bundleWorker();

  const configured = configuredStorage();

  const { memory, s3, probes } = await withWorkerd(async (origins) => ({
    memory: await resultsOf(origins.harness, "adapter-memory"),
    s3: configured === undefined ? undefined : await resultsOf(origins.harness, "adapter-s3"),
    probes: {
      harness: await probesOf(origins.harness),
      defaults: await probesOf(origins.defaults),
    },
  }));

  describeResults(framework, "@stowage/adapter-memory", memory);

  describeEndpointCheck(framework, configured);

  if (s3 !== undefined) describeResults(framework, "@stowage/adapter-s3", s3);

  return probes;
}

/** What the worker answers about itself beside the cases, for Node to assert on. */
export interface WorkerdProbes {
  readonly harness: WorkerProbes;
  readonly defaults: WorkerProbes;
}

export interface WorkerProbes {
  readonly nodeApi: NodeApiReach;
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
 * The sockets of `workerd.capnp`: `harness` reaches the worker at the flags of spec 1,
 * `defaults` the same module at the defaults its compatibility date turns on.
 */
interface Origins {
  readonly harness: string;
  readonly defaults: string;
}

async function withWorkerd<T>(use: (origins: Origins) => Promise<T>): Promise<T> {
  // The package hands out the path of the binary built for this machine as its default
  // export.
  const workerd: { readonly default: string } = createRequire(import.meta.url)("workerd");

  const child = spawn(workerd.default, ["serve", "workerd.capnp", "--control-fd=3"], {
    cwd: harnessDirectory,
    stdio: ["ignore", "inherit", "inherit", "pipe"],
  });
  const exited = once(child, "exit").catch(() => {});

  try {
    const ports = await listeningPorts(child, ["harness", "defaults"]);

    return await use({
      harness: `http://127.0.0.1:${ports.get("harness")}`,
      defaults: `http://127.0.0.1:${ports.get("defaults")}`,
    });
  } finally {
    child.kill();
    await exited;
  }
}

/** The ports `workerd` reports on the control descriptor once the named sockets listen. */
async function listeningPorts(
  child: ChildProcess,
  sockets: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const [, , , control] = child.stdio;

  if (!(control instanceof Readable)) throw new Error("`workerd` has no control descriptor");

  const ports = new Map<string, number>();

  for await (const line of createInterface({ input: control })) {
    const message: {
      readonly event?: unknown;
      readonly socket?: unknown;
      readonly port?: unknown;
    } = JSON.parse(line);

    if (
      message.event === "listen" &&
      typeof message.socket === "string" &&
      typeof message.port === "number"
    ) {
      ports.set(message.socket, message.port);
    }

    if (sockets.every((socket) => ports.has(socket))) return ports;
  }

  throw new Error("`workerd` exited before its sockets listened");
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

async function probesOf(origin: string): Promise<WorkerProbes> {
  return { nodeApi: await answerOf<NodeApiReach>(origin, "node-api") };
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
