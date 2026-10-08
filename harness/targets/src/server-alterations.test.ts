import { afterEach, describe, expect, test, vi } from "vitest";

import type { CaseOf } from "../../../packages/conformance/src/case.ts";
import { type ServerAlteration, withServerAlterations } from "./server-alterations.ts";

// The cases below read nothing off the context.
type Context = undefined;

const origin = "http://server.test";

const alteration: ServerAlteration = {
  cases: ["serve/head", "serve/whole"],
  differs: "It answers a `HEAD` with `Content-Length: 0`",
  restore: (method, answer) => {
    if (method !== "HEAD" || answer.headers.get("content-length") !== "0") return undefined;

    const headers = new Headers(answer.headers);

    headers.delete("content-length");

    return headers;
  },
};

const server = { name: "a server", alterations: [alteration] };

/** A case of the given name that sends a `HEAD` to `url` and hands the answer to `check`. */
const heading = (
  check: (answer: Response) => void,
  url = `${origin}/serve/a`,
  name = "serve/head",
): CaseOf<Context> => ({
  name,
  requires: [],
  cost: "fast",
  run: async () => check(await fetch(url, { method: "HEAD" })),
});

const runOnly = async (sources: readonly CaseOf<Context>[]): Promise<void> => {
  const [source] = sources;

  if (source === undefined) throw new Error("No case to run");

  await source.run(undefined);
};

/** Every server and storage answering a `HEAD` the way the altering server does. */
const answeringWithLengthZero = (): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => new Response(null, { headers: { "content-length": "0" } })),
  );
};

afterEach(() => vi.unstubAllGlobals());

describe("withServerAlterations", () => {
  test("hands the cases of a server without alterations over as they are", () => {
    const source = heading(() => {});

    expect(withServerAlterations([source], { name: "a server" }, origin)).toEqual([source]);
  });

  test("hands a case without an entry over as it is", () => {
    const source = heading(() => {}, `${origin}/serve/a`, "serve/headers");

    expect(withServerAlterations([source], server, origin)).toEqual([source]);
  });

  test("hands the case the server's answer with the headers the layer gave it", async () => {
    answeringWithLengthZero();

    let length: string | null | undefined;

    await runOnly(
      withServerAlterations(
        [heading((answer) => void (length = answer.headers.get("content-length")))],
        server,
        origin,
      ),
    );

    expect(length).toBeNull();
  });

  test("restores the answers of every case its entry names", async () => {
    answeringWithLengthZero();

    let length: string | null | undefined;

    await runOnly(
      withServerAlterations(
        [
          heading(
            (answer) => void (length = answer.headers.get("content-length")),
            `${origin}/serve/a`,
            "serve/whole",
          ),
        ],
        server,
        origin,
      ),
    );

    expect(length).toBeNull();
  });

  test("leaves the answers of another origin, the storage's among them, as they are", async () => {
    answeringWithLengthZero();

    const lengths: (string | null)[] = [];
    const source: CaseOf<Context> = {
      ...heading(() => {}),
      run: async () => {
        for (const url of ["http://storage.test/bucket/a", `${origin}/serve/a`]) {
          // oxlint-disable-next-line no-await-in-loop -- one request after the other
          const answer = await fetch(url, { method: "HEAD" });

          lengths.push(answer.headers.get("content-length"));
        }
      },
    };

    await runOnly(withServerAlterations([source], server, origin));

    expect(lengths).toEqual(["0", null]);
  });

  test("puts `fetch` back once the case has run", async () => {
    answeringWithLengthZero();

    const stubbed = globalThis.fetch;

    await runOnly(withServerAlterations([heading(() => {})], server, origin));

    expect(globalThis.fetch).toBe(stubbed);
  });

  test("fails a case that met no altered answer, naming the case, the server and the change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null)),
    );

    await expect(
      runOnly(
        withServerAlterations(
          [heading(() => {}, `${origin}/serve/a`, "serve/whole")],
          server,
          origin,
        ),
      ),
    ).rejects.toThrow(
      "`serve/whole` ran on a server without meeting the change its alterations expect: It answers a `HEAD` with `Content-Length: 0`",
    );
  });

  test("fails a case that fails, with its own error", async () => {
    answeringWithLengthZero();

    const failing = heading(() => {
      throw new Error("`HEAD` answers 500");
    });

    await expect(runOnly(withServerAlterations([failing], server, origin))).rejects.toThrow(
      "`HEAD` answers 500",
    );
  });

  test("restores the answers of the half without the capability as well", async () => {
    answeringWithLengthZero();

    let length: string | null | undefined;
    const [wrapped] = withServerAlterations(
      [
        {
          name: "serve/head",
          requires: ["rangeReads"],
          cost: "fast",
          run: async () => {},
          runWithout: async () => {
            const answer = await fetch(`${origin}/serve/a`, { method: "HEAD" });

            length = answer.headers.get("content-length");
          },
        },
      ],
      server,
      origin,
    );

    if (wrapped === undefined || !("runWithout" in wrapped)) throw new Error("No half to run");

    await wrapped.runWithout(undefined);

    expect(length).toBeNull();
  });
});
