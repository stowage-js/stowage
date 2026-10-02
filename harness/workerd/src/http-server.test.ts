import { ChildProcess } from "node:child_process";

import { expect, test, vi } from "vitest";

import { workerdServer } from "./http-server.ts";
import { listeningPorts, spawnWorkerd } from "./workerd-process.ts";

vi.mock("./workerd-process.ts", () => ({
  spawnWorkerd: vi.fn<typeof spawnWorkerd>(),
  listeningPorts: vi.fn<typeof listeningPorts>(),
}));

const configured = {
  bucket: "stowage",
  region: "us-east-1",
  credentials: { accessKeyId: "unused", secretAccessKey: "unused" },
};

test("kills the child and waits for exit before rethrowing a listening failure", async () => {
  const child = new ChildProcess();
  const killed = Promise.withResolvers<void>();
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {
    killed.resolve();
    return true;
  });
  const failure = new Error("Invalid control message");

  vi.mocked(spawnWorkerd).mockReturnValueOnce(child);
  vi.mocked(listeningPorts).mockRejectedValueOnce(failure);

  let finished = false;
  const started = workerdServer("spec").start(configured);
  const rejected = started.catch((error: unknown) => {
    finished = true;
    return error;
  });
  await killed.promise;

  expect(kill).toHaveBeenCalledOnce();
  expect(finished).toBe(false);

  child.emit("exit", null, "SIGTERM");
  expect(await rejected).toBe(failure);
});

test("keeps the listening child until close and waits for its exit", async () => {
  const child = new ChildProcess();
  const kill = vi.spyOn(child, "kill").mockReturnValue(true);

  vi.mocked(spawnWorkerd).mockReturnValueOnce(child);
  vi.mocked(listeningPorts).mockResolvedValueOnce({ http: 12345 });

  const started = await workerdServer("spec").start(configured);

  expect(started.url("serve", "a").href).toBe("http://127.0.0.1:12345/serve/a");
  expect(kill).not.toHaveBeenCalled();

  let finished = false;
  const closed = started.close().then(() => void (finished = true));

  await Promise.resolve();
  expect(kill).toHaveBeenCalledOnce();
  expect(finished).toBe(false);

  child.emit("exit", null, "SIGTERM");
  await closed;
});
