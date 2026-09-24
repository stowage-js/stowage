import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { get, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { env } from "node:process";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";
import type { describe, test } from "vitest";

import type { ConformanceResult } from "../../../packages/conformance/src/result.ts";
import { configuredStorage } from "../../s3/src/environment.ts";
import { firstRunSuite, measuredOnWorkerd } from "../../s3/src/first-run.ts";
import { describeEndpointCheck } from "../../s3/src/target.ts";
import { runOptionsFrom } from "../../targets/src/run-options.ts";
import { excludedCases } from "./excluded.ts";

const harnessDirectory = fileURLToPath(new URL("..", import.meta.url));

/**
 * Vitest's own functions rather than the three frameworks' common shape: the results are
 * reported on Node alone, and a measurement carries what it saw in the test's `meta`.
 */
export interface VitestFramework {
  readonly describe: typeof describe;
  readonly test: typeof test;
}

interface Workerd {
  readonly origin: string;
  readonly pid: number | undefined;
}

interface Measurement {
  readonly name: string;
  readonly result: ConformanceResult | undefined;
  readonly seconds: number;
  readonly cpuSeconds: number | undefined;
}

/**
 * ADR 0006: `workerd` has no test function to hand the cases to, so the worker runs them
 * and answers with the results, and the harness reports each one on Node as a test of its
 * own, named as `describeConformance` names the case.
 */
export async function describeWorkerd(framework: VitestFramework): Promise<void> {
  await bundleWorker();

  const configured = configuredStorage();
  // Spec 12 asks the scheduled run, and not every commit, what a multipart upload costs.
  const measuring = configured !== undefined && runOptionsFrom(env).includeSlow === true;

  const { memory, s3, measured } = await withWorkerd(async (workerd) => ({
    memory: await resultsOf(workerd.origin, "adapter-memory"),
    s3: configured === undefined ? undefined : await resultsOf(workerd.origin, "adapter-s3"),
    measured: measuring ? await measureExcluded(workerd) : [],
  }));

  describeResults(framework, "@stowage/adapter-memory", memory);

  describeEndpointCheck(framework, configured);

  if (s3 !== undefined) describeResults(framework, "@stowage/adapter-s3", s3);

  if (measured.length > 0) describeMeasurements(framework, measured);
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

async function withWorkerd<T>(use: (workerd: Workerd) => Promise<T>): Promise<T> {
  // The package hands out the path of the binary built for this machine as its default
  // export.
  const workerd: { readonly default: string } = createRequire(import.meta.url)("workerd");

  const child = spawn(workerd.default, ["serve", "workerd.capnp", "--control-fd=3"], {
    cwd: harnessDirectory,
    stdio: ["ignore", "inherit", "inherit", "pipe"],
  });
  const exited = once(child, "exit").catch(() => {});

  try {
    return await use({ origin: `http://127.0.0.1:${await listeningPort(child)}`, pid: child.pid });
  } finally {
    child.kill();
    await exited;
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

/** Each excluded case alone, one after the other, so that no two share the CPU counted. */
async function measureExcluded(workerd: Workerd): Promise<readonly Measurement[]> {
  const measured: Measurement[] = [];

  for (const name of excludedCases) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time is what makes the CPU theirs
    measured.push(await measure(workerd, name));
  }

  return measured;
}

async function measure(workerd: Workerd, name: string): Promise<Measurement> {
  const cpuBefore = await cpuSecondsOf(workerd.pid);
  const started = performance.now();
  const [result] = await resultsOf(
    workerd.origin,
    `adapter-s3?excluded=${encodeURIComponent(name)}`,
  );
  const seconds = (performance.now() - started) / 1000;
  const cpuAfter = await cpuSecondsOf(workerd.pid);

  return {
    name,
    result,
    seconds,
    cpuSeconds:
      cpuBefore === undefined || cpuAfter === undefined ? undefined : cpuAfter - cpuBefore,
  };
}

/**
 * The CPU the `workerd` process spent, user and system, out of `/proc/<pid>/stat`, which
 * counts in the fixed 100 ticks a second Linux reports there. Elsewhere there is none to
 * read, and the measurement is the duration alone.
 */
async function cpuSecondsOf(pid: number | undefined): Promise<number | undefined> {
  if (pid === undefined) return undefined;

  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The fields after the command, whose name may hold spaces, start with the third.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [userTicks, systemTicks] = [Number(fields[11]), Number(fields[12])];

    return (userTicks + systemTicks) / 100;
  } catch {
    return undefined;
  }
}

/**
 * A measurement passes whatever the case did: spec 2 promises no flow 1 on `workerd`,
 * and spec 12 asks what the upload costs there, which a failure answers as well.
 */
function describeMeasurements(framework: VitestFramework, measured: readonly Measurement[]): void {
  framework.describe(firstRunSuite, () => {
    for (const measurement of measured) {
      framework.test(measuredOnWorkerd(measurement.name), ({ task }) => {
        task.meta.observed = observationOf(measurement);
      });
    }
  });
}

function observationOf(measurement: Measurement): string {
  const cpu =
    measurement.cpuSeconds === undefined
      ? ""
      : `, ${measurement.cpuSeconds.toFixed(1)} s of CPU in the \`workerd\` process`;
  const duration = `${measurement.seconds.toFixed(1)} s${cpu}`;
  const result = measurement.result;

  if (result === undefined) return `no result after ${duration}`;
  if (result.status === "failed") return `failed after ${duration}: ${result.error.message}`;
  if (result.status === "skipped") return `skipped: ${result.reason}`;

  return `passed in ${duration}`;
}

function describeResults(
  framework: VitestFramework,
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
