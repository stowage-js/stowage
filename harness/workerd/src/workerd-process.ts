import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const harnessDirectory = fileURLToPath(new URL("..", import.meta.url));

/**
 * `workerd serve` with `args` in the harness directory, where the configs embed `dist`,
 * reporting its sockets on the control descriptor. Without `environment` it inherits the
 * harness's, which the bindings of `workerd.capnp` read.
 */
export function spawnWorkerd(
  args: readonly string[],
  environment?: Readonly<Record<string, string>>,
): ChildProcess {
  // The package hands out the path of the binary built for this machine as its default
  // export.
  const workerd: { readonly default: string } = createRequire(import.meta.url)("workerd");

  return spawn(workerd.default, ["serve", ...args, "--control-fd=3"], {
    cwd: harnessDirectory,
    env: environment,
    stdio: ["ignore", "inherit", "inherit", "pipe"],
  });
}

/** The ports `workerd` reports on the control descriptor once every one of `sockets` listens. */
export async function listeningPorts<Socket extends string>(
  child: ChildProcess,
  sockets: readonly Socket[],
): Promise<Record<Socket, number>> {
  const [, , , control] = child.stdio;

  if (!(control instanceof Readable)) throw new Error("`workerd` has no control descriptor");

  const ports = new Map<Socket, number>();

  for await (const line of createInterface({ input: control })) {
    const message: {
      readonly event?: unknown;
      readonly socket?: unknown;
      readonly port?: unknown;
    } = JSON.parse(line);
    const socket = sockets.find((each) => each === message.socket);

    if (message.event === "listen" && socket !== undefined && typeof message.port === "number") {
      ports.set(socket, message.port);
    }

    if (ports.size === sockets.length) {
      // oxlint-disable-next-line no-unsafe-type-assertion -- every socket holds its port by now
      return Object.fromEntries(ports) as Record<Socket, number>;
    }
  }

  throw new Error("`workerd` exited before its sockets listened");
}
