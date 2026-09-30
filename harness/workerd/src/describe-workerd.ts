import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, readFile } from "node:fs/promises";
import { get, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { env } from "node:process";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";

import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import type { ConformanceResult } from "../../../packages/conformance/src/result.ts";
import { scheduledAgainstAccount } from "../../azure-blob/src/configuration.ts";
import { configuredStorage as configuredAzureBlobStorage } from "../../azure-blob/src/environment.ts";
import { describeAzureBlobEndpointCheck } from "../../azure-blob/src/target.ts";
import { scheduledAgainstBucket } from "../../gcs/src/configuration.ts";
import { configuredEndpoint as configuredGcsEndpoint } from "../../gcs/src/environment.ts";
import { describeGcsEndpointCheck } from "../../gcs/src/target.ts";
import { configuredStorage } from "../../s3/src/environment.ts";
import { describeEndpointCheck } from "../../s3/src/target.ts";
import { type CoreCheckResult, describeCoreResults } from "../../targets/src/core.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import type { FromEnvOutcome } from "./from-env.ts";
import type { NodeApiReach } from "./node-api.ts";

const harnessDirectory = fileURLToPath(new URL("..", import.meta.url));

/**
 * ADR 0006: `workerd` has no test function to hand the cases to, so the worker runs them
 * and answers with the results, and the harness reports each one on Node as a test of its
 * own, named as `describeConformance` names the case. What each worker reports about
 * itself beside the cases, and what flow 1 cost against the Azure account and the GCS
 * bucket, is handed back for the caller to assert on and report.
 */
export async function describeWorkerd(framework: ConformanceFramework): Promise<WorkerdRun> {
  await bundleWorker();
  await placeTrustedCertificate();

  const endpointTiers = endpointTiersFrom(env);
  const configured = endpointTiers.has("s3") ? configuredStorage() : undefined;
  const configuredAzureBlob = endpointTiers.has("azure-blob")
    ? configuredAzureBlobStorage()
    : undefined;
  const configuredGcs = endpointTiers.has("gcs") ? configuredGcsEndpoint() : undefined;

  const measuringAzureBlob = configuredAzureBlob !== undefined && scheduledAgainstAccount(env);
  const measuringGcs = configuredGcs?.kind === "bucket" && scheduledAgainstBucket(env);
  // Without `--verbose`, `workerd` keeps to itself the internal errors that close a connection
  // unanswered, and the job against the bucket is where one closed (#258).
  const verbose = configuredGcs?.kind === "bucket";

  const { core, memory, s3, azureBlob, gcs, probes, flowOne } = await withWorkerd(
    { verbose },
    async (workerd) => {
      const { origins } = workerd;

      return {
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
        gcs:
          configuredGcs === undefined
            ? undefined
            : {
                harness: await resultsOf(origins.harness, "adapter-gcs"),
                defaults: await resultsOf(origins.defaults, "adapter-gcs"),
              },
        probes: {
          harness: await probesOf(origins.harness),
          defaults: await probesOf(origins.defaults),
        },
        // After every other run, so that the CPU the process spends meanwhile is the upload's.
        flowOne: {
          azureBlob: measuringAzureBlob
            ? await measureFlowOne(workerd, "adapter-azure-blob")
            : undefined,
          gcs: measuringGcs ? await measureFlowOne(workerd, "adapter-gcs") : undefined,
        },
      };
    },
  );

  describeCoreResults(framework, core);

  describeResults(framework, "@stowage/adapter-memory", memory);

  if (endpointTiers.has("s3")) describeEndpointCheck(framework, configured);

  if (s3 !== undefined) describeResults(framework, "@stowage/adapter-s3", s3);

  if (endpointTiers.has("azure-blob")) {
    describeAzureBlobEndpointCheck(framework, configuredAzureBlob);
  }

  if (azureBlob !== undefined) {
    describeResults(framework, "@stowage/adapter-azure-blob", azureBlob.harness);
    describeResults(
      framework,
      "@stowage/adapter-azure-blob at the default flags",
      azureBlob.defaults,
    );
  }

  if (endpointTiers.has("gcs")) describeGcsEndpointCheck(framework, configuredGcs);

  if (gcs !== undefined) {
    describeResults(framework, "@stowage/adapter-gcs", gcs.harness);
    describeResults(framework, "@stowage/adapter-gcs at the default flags", gcs.defaults);
  }

  return { probes, flowOne };
}

export interface WorkerdRun {
  readonly probes: Record<Socket, Probes>;
  /** Flow 1 against each real endpoint the scheduled run asks for the slow tier on. */
  readonly flowOne: {
    readonly azureBlob: Measurement | undefined;
    readonly gcs: Measurement | undefined;
  };
}

/** One case run on its own in the worker, with the time and the CPU it took. */
export interface Measurement {
  readonly result: ConformanceResult | undefined;
  readonly seconds: number;
  /** The CPU of the `workerd` process, where `/proc` reports one. */
  readonly cpuSeconds: number | undefined;
}

interface Workerd {
  readonly origins: Record<Socket, string>;
  readonly pid: number | undefined;
}

/**
 * Spec 14, ADR 0026 and ADR 0039: the 17 MiB upload of flow 1 on `workerd` against the
 * account or the bucket, and what it spends there, which the host note of spec 2 reads
 * against a paid plan's limits. Both numbers overstate the upload: the worker's resolvers
 * serve one request, so the measured one exchanges the job's OIDC token first, and `/proc`
 * counts the whole process rather than the isolate a plan limits.
 */
async function measureFlowOne(
  workerd: Workerd,
  adapter: "adapter-azure-blob" | "adapter-gcs",
): Promise<Measurement> {
  const cpuBefore = await cpuSecondsOf(workerd.pid);
  const started = performance.now();
  const [result] = await resultsOf(
    workerd.origins.harness,
    `${adapter}?case=${encodeURIComponent("flow/1-large-upload")}`,
  );
  const seconds = (performance.now() - started) / 1000;
  const cpuAfter = await cpuSecondsOf(workerd.pid);

  return {
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

/** What the report shows for the measurement, whatever the case did. */
export function observationOf(measurement: Measurement, tokenExchanges: string): string {
  const cpu =
    measurement.cpuSeconds === undefined
      ? ""
      : `, ${measurement.cpuSeconds.toFixed(1)} s of CPU in the \`workerd\` process`;
  const duration = `${measurement.seconds.toFixed(1)} s${cpu}`;
  const { result } = measurement;

  if (result === undefined) return `no result after ${duration}`;
  if (result.status === "failed") return `failed after ${duration}: ${result.error.message}`;
  if (result.status === "skipped") return `skipped: ${result.reason}`;

  return `passed in ${duration}, ${tokenExchanges} included`;
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

async function withWorkerd<T>(
  { verbose }: { readonly verbose: boolean },
  use: (workerd: Workerd) => Promise<T>,
): Promise<T> {
  // The package hands out the path of the binary built for this machine as its default
  // export.
  const workerd: { readonly default: string } = createRequire(import.meta.url)("workerd");
  const flags = verbose ? ["--verbose"] : [];

  const child = spawn(workerd.default, ["serve", "workerd.capnp", "--control-fd=3", ...flags], {
    cwd: harnessDirectory,
    stdio: ["ignore", "inherit", "inherit", "pipe"],
  });
  const exited = once(child, "exit").catch(() => {});

  try {
    const ports = await listeningPorts(child);

    return await use({
      origins: {
        harness: `http://127.0.0.1:${ports.harness}`,
        defaults: `http://127.0.0.1:${ports.defaults}`,
      },
      pid: child.pid,
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
  const started = performance.now();
  // A connection `workerd` drops says nothing of which run it carried.
  const lost = (failure: unknown): Error =>
    new Error(
      `The request for ${path} at ${origin} failed after ${((performance.now() - started) / 1000).toFixed(1)} s: ${failure instanceof Error ? failure.message : String(failure)}`,
      { cause: failure },
    );
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(`${origin}/${path}`, resolve).on("error", (failure) => reject(lost(failure)));
  });
  const body = await text(response).catch((failure: unknown) => {
    throw lost(failure);
  });

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
