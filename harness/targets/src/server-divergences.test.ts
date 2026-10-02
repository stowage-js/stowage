import { describe, expect, test } from "vitest";

import type { CaseOf } from "../../../packages/conformance/src/case.ts";
import { type ServerDivergence, withServerDivergences } from "./server-divergences.ts";

// The cases below read nothing off the context.
type Context = undefined;

const passing: CaseOf<Context> = {
  name: "serve/head",
  requires: [],
  cost: "fast",
  run: async () => {},
};

const failing = (message: string): CaseOf<Context> => ({
  name: "serve/head",
  requires: [],
  cost: "fast",
  run: async () => {
    throw new Error(message);
  },
});

const entry: ServerDivergence = {
  case: "serve/head",
  differs: "It answers a `HEAD` with `Content-Length: 0`",
  failureMessagePart: '`content-length: "0"`',
};

const server = { name: "a server", divergences: [entry] };

const runOnly = async (sources: readonly CaseOf<Context>[]): Promise<void> => {
  const [source] = sources;

  if (source === undefined) throw new Error("No case to run");

  await source.run(undefined);
};

describe("withServerDivergences", () => {
  test("hands the cases of a server without divergences over as they are", () => {
    expect(withServerDivergences([passing], { name: "a server" })).toEqual([passing]);
  });

  test("hands a case without an entry over as it is", () => {
    const other = { ...passing, name: "serve/whole" };

    expect(withServerDivergences([other], server)).toEqual([other]);
  });

  test("passes a case that fails as its entry says", async () => {
    await expect(
      runOnly(withServerDivergences([failing('`HEAD` carries `content-length: "0"`')], server)),
    ).resolves.toBeUndefined();
  });

  test("fails a case that fails otherwise, with its own error", async () => {
    await expect(
      runOnly(withServerDivergences([failing("`HEAD` answers 500")], server)),
    ).rejects.toThrow("`HEAD` answers 500");
  });

  test("fails a case that passes, naming the server and the difference", async () => {
    await expect(runOnly(withServerDivergences([passing], server))).rejects.toThrow(
      "`serve/head` passed on a server, whose divergences expect it to fail: It answers a `HEAD` with `Content-Length: 0`",
    );
  });

  test("expects the half without the capability to fail as well", async () => {
    const [wrapped] = withServerDivergences(
      [
        {
          name: "serve/head",
          requires: ["rangeReads"],
          cost: "fast",
          run: async () => {},
          runWithout: async () => {
            throw new Error('`HEAD` carries `content-length: "0"`');
          },
        },
      ],
      server,
    );

    if (wrapped === undefined || !("runWithout" in wrapped)) throw new Error("No half to run");

    await expect(wrapped.runWithout(undefined)).resolves.toBeUndefined();
  });
});
