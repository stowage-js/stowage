import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { env } from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { variablesOf } from "../../s3/src/configuration.ts";
import type { HttpServer } from "./http.ts";
import type { MeterAnswer, MeterRequest } from "./meter-over-ipc.ts";
import { routeUrls } from "./routes.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

/** The application's sources, which `harness/nextjs` installs the newest Next.js 16 for. */
const application = join(repository, "harness/nextjs");

/** What a run copies of the application: everything `next build` reads. */
const applicationSources = ["app", "lib", "next.config.js"];

const meterOverIpc = fileURLToPath(new URL("meter-over-ipc.ts", import.meta.url));

/**
 * The package whose `next` builds the application: `harness/nextjs` for the newest release,
 * `harness/floors` for the floor, as `STOWAGE_NEXTJS_PACKAGE` names it relative to the
 * repository (spec 2).
 */
const nextjsPackage = join(repository, env["STOWAGE_NEXTJS_PACKAGE"] ?? "harness/nextjs");

/** The application, built once for a run: the `next` CLI it was built with and its output. */
export interface NextjsBuild {
  readonly next: string;
  readonly output: string;
}

/** Spec 2's cell of `@stowage/nextjs`, whose build the run removes once it is over. */
export interface NextjsServer extends HttpServer {
  /** Builds the application on the first call; every later call and every start awaits it. */
  build(): Promise<NextjsBuild>;
  remove(): Promise<void>;
}

/**
 * Spec 2's cell of `@stowage/nextjs`: the application served by `next start`, which the
 * Node harness starts as a child process (spec 2).
 */
export function nextjsServer(): NextjsServer {
  const directory = runDirectory();
  let built: Promise<NextjsBuild> | undefined;
  const build = async (): Promise<NextjsBuild> => await (built ??= builtApplication(directory));

  return {
    name: "@stowage/nextjs",
    build,
    remove: async () => await rm(directory, { recursive: true, force: true }),
    start: async (configured, routes) => {
      const { next } = await build();
      const child = spawn(
        process.execPath,
        ["--import", meterOverIpc, next, "start", "--port", "0", "--hostname", "127.0.0.1"],
        {
          cwd: directory,
          env: {
            ...withoutStorageVariables(env),
            ...(await variablesOf(configured)),
            ...(routes === undefined ? {} : { STOWAGE_HTTP_MAX_SIZE: String(routes.maxSize) }),
          },
          stdio: ["ignore", "pipe", "inherit", "ipc"],
        },
      );
      const exited = once(child, "exit").catch(() => {});
      const origin = await listeningOrigin(child).catch(async (failure: unknown) => {
        child.kill();
        await exited;
        throw failure;
      });

      return {
        url: routeUrls(origin),
        meterApart: async () => {
          await asked(child, "start", "started");

          return async () => (await asked(child, "growth", "growth")).bytes;
        },
        close: async () => {
          child.kill();
          await exited;
        },
      };
    },
  };
}

/**
 * A directory of its own below the package whose `next` builds the application, so that the
 * runs of several files build side by side and the floor builds with its own `next`.
 */
function runDirectory(): string {
  return join(nextjsPackage, ".next-runs", crypto.randomUUID());
}

/**
 * The application copied into `directory` and built there with `next build`. The build runs
 * without the variables the storage is configured from, so that a storage constructed while
 * Next.js evaluates the application's modules fails it (spec 13).
 */
async function builtApplication(directory: string): Promise<NextjsBuild> {
  await copyApplication(directory);

  const next = await nextOf(directory);

  return { next, output: await nextBuild(next, directory) };
}

/**
 * What `next build` reports for the application changed to construct its storage while its
 * module is evaluated, as it would without `lazyStorage`: the failure that a build of the
 * application as it is would meet if anything constructed the storage at build time.
 */
export async function eagerBuildFailure(): Promise<string> {
  const directory = runDirectory();

  try {
    await copyApplication(directory);

    const storageModule = join(directory, "lib/storage.js");

    await writeFile(storageModule, `${await readFile(storageModule, "utf8")}\nstorage();\n`);

    const output = await nextBuild(await nextOf(directory), directory).catch((failure: unknown) =>
      failure instanceof Error ? failure : undefined,
    );

    if (!(output instanceof Error)) throw new Error("`next build` passed a storage built eagerly");

    return output.message;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function copyApplication(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all(
    applicationSources.map(
      async (source) =>
        await cp(join(application, source), join(directory, source), { recursive: true }),
    ),
  );
}

/** Runs `next build` in `directory` and resolves to its output, or rejects with it. */
async function nextBuild(next: string, directory: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [next, "build"],
      { cwd: directory, env: withoutStorageVariables(env) },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`\`next build\` failed:\n${stdout}${stderr}`, { cause: error }));
      },
    );
  });
}

/**
 * The `next` CLI that `directory` resolves, refused unless it is the release the package
 * pins: a build that reached another copy would pass as that release's and prove nothing
 * about it.
 */
async function nextOf(directory: string): Promise<string> {
  const resolve = createRequire(join(directory, "package.json")).resolve;
  const { version }: { readonly version: string } = JSON.parse(
    await readFile(resolve("next/package.json"), "utf8"),
  );
  const manifest: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  } = JSON.parse(await readFile(join(nextjsPackage, "package.json"), "utf8"));
  const pinned = manifest.dependencies?.["next"] ?? manifest.devDependencies?.["next"];

  if (version !== pinned) {
    throw new Error(`\`next\` resolved to ${version} below ${nextjsPackage}, not ${pinned}`);
  }

  return resolve("next/dist/bin/next");
}

/**
 * The environment without the variables `start.sh` prints, which `next build` must not see
 * and `next start` takes from the storage it is started with. Telemetry stays off.
 */
function withoutStorageVariables(variables: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(variables).filter(([name]) => !/^(?:STOWAGE_S3_|AWS_)/u.test(name)),
    ),
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

/** The origin `next start` prints once it listens, on the port the system chose. */
async function listeningOrigin(child: ChildProcess): Promise<string> {
  const { stdout } = child;

  if (stdout === null) throw new Error("`next start` has no standard output");

  let origin: string | undefined;

  for await (const line of createInterface({ input: stdout })) {
    [origin] = /http:\/\/127\.0\.0\.1:\d+/u.exec(line) ?? [];

    if (origin !== undefined) break;
  }

  if (origin === undefined) throw new Error("`next start` exited before it listened");

  // Leaving the loop closed the reader, which paused the stream. What `next start` logs from
  // here on is read and dropped, so that a full pipe never stalls it.
  stdout.resume();

  return origin;
}

async function asked<Answer extends MeterAnswer["stowageMeter"]>(
  child: ChildProcess,
  request: MeterRequest["stowageMeter"],
  expected: Answer,
): Promise<Extract<MeterAnswer, { stowageMeter: Answer }>> {
  const answered = new Promise<Extract<MeterAnswer, { stowageMeter: Answer }>>(
    (resolve, reject) => {
      const listener = (message: Partial<MeterAnswer> | null): void => {
        if (message?.stowageMeter !== expected) return;

        cleanup();
        // oxlint-disable-next-line no-unsafe-type-assertion -- the meter answers in this shape
        resolve(message as Extract<MeterAnswer, { stowageMeter: Answer }>);
      };
      const stopped = (): void => {
        cleanup();
        reject(new Error("`next start` exited or disconnected before answering the meter"));
      };
      const cleanup = (): void => {
        child.off("message", listener);
        child.off("exit", stopped);
        child.off("disconnect", stopped);
      };

      child.on("message", listener);
      child.once("exit", stopped);
      child.once("disconnect", stopped);
    },
  );

  child.send({ stowageMeter: request } satisfies MeterRequest);

  return await answered;
}
