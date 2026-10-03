import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
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
export function nextjsPackage(): string {
  return join(repository, env["STOWAGE_NEXTJS_PACKAGE"] ?? "harness/nextjs");
}

/** The application, built once for a run, with what `next build` printed. */
export interface NextjsBuild {
  readonly directory: string;
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
 * Node harness starts as a child process (spec 2). Each run copies the application into a
 * directory of its own below `packageDirectory`, whose `next` it resolves, so that runs of
 * several files build side by side and the floor builds with its own `next`.
 */
export function nextjsServer(packageDirectory: string = nextjsPackage()): NextjsServer {
  const directory = join(packageDirectory, ".next-runs", crypto.randomUUID());
  let built: Promise<NextjsBuild> | undefined;
  const build = async (): Promise<NextjsBuild> =>
    await (built ??= builtApplication(packageDirectory, directory));

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
          await asked(child, "start");

          return async () => {
            const answer = await asked(child, "growth");

            return answer.stowageMeter === "growth" ? answer.bytes : 0;
          };
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
 * Copies the application into `directory` and builds it there with `next build`. The build
 * runs without the variables the storage is configured from, so that a storage constructed
 * while Next.js evaluates the application's modules fails it (spec 13): that it passes is
 * what shows `lazyStorage` constructing nothing at build time.
 */
async function builtApplication(packageDirectory: string, directory: string): Promise<NextjsBuild> {
  await mkdir(directory, { recursive: true });
  await Promise.all(
    applicationSources.map(
      async (source) =>
        await cp(join(application, source), join(directory, source), { recursive: true }),
    ),
  );

  const next = await nextOf(packageDirectory, directory);
  const output = await new Promise<string>((resolve, reject) => {
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

  return { directory, next, output };
}

/**
 * The `next` CLI that `directory` resolves, refused unless it is the release the package
 * pins: a build that reached another copy would pass as that release's and prove nothing
 * about it.
 */
async function nextOf(packageDirectory: string, directory: string): Promise<string> {
  const resolve = createRequire(join(directory, "package.json")).resolve;
  const { version }: { readonly version: string } = JSON.parse(
    await readFile(resolve("next/package.json"), "utf8"),
  );
  const manifest: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  } = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  const pinned = manifest.dependencies?.["next"] ?? manifest.devDependencies?.["next"];

  if (version !== pinned) {
    throw new Error(`\`next\` resolved to ${version} below ${packageDirectory}, not ${pinned}`);
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

/** Sends `request` to the meter of `meter-over-ipc.ts` and resolves to its answer. */
async function asked(
  child: ChildProcess,
  request: MeterRequest["stowageMeter"],
): Promise<MeterAnswer> {
  const expected = request === "start" ? "started" : "growth";
  const answered = new Promise<MeterAnswer>((resolve) => {
    const listener = (message: Partial<MeterAnswer> | null): void => {
      if (message?.stowageMeter !== expected) return;

      child.off("message", listener);
      // oxlint-disable-next-line no-unsafe-type-assertion -- the meter answers in this shape
      resolve(message as MeterAnswer);
    };

    child.on("message", listener);
  });

  child.send({ stowageMeter: request } satisfies MeterRequest);

  return await answered;
}
