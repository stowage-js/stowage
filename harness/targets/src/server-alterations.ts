import type { CaseOf } from "../../../packages/conformance/src/case.ts";

/**
 * A change a runtime's own server makes to the answers of HTTP cases on their way to the
 * socket, setting or dropping a header that no answer of the layer can keep it from.
 * It is no divergence (`CONTEXT.md`): no other run settles it, and a client of that cell
 * sees it, so spec 2 names each one below its second table.
 */
export interface ServerAlteration {
  /** The HTTP cases the change shows up in, each failing a run where it meets none. */
  readonly cases: readonly string[];
  /** What the server does to the answer. */
  readonly differs: string;
  /**
   * The headers of `answer` as the layer answered with them, where `answer` carries the
   * change; `undefined` for an answer that does not.
   */
  restore(method: string, answer: Response): Headers | undefined;
}

/** A server of spec 2's second table, as far as its alterations go. */
export interface AlteringServer {
  readonly name: string;
  readonly alterations?: readonly ServerAlteration[];
}

/**
 * The cases as a run against `server` at `origin` performs them. A case with an entry
 * meets the answers of the server with the change undone, so that every other assertion
 * of the case still runs there; it fails where it meets no changed answer, so that a
 * runtime release that stops the change reaches the list and spec 2.
 */
export function withServerAlterations<Context>(
  sources: readonly CaseOf<Context>[],
  server: AlteringServer,
  origin: string,
): readonly CaseOf<Context>[] {
  return sources.map((source) => {
    const alteration = server.alterations?.find((entry) => entry.cases.includes(source.name));

    if (alteration === undefined) return source;

    const restoring =
      (half: (ctx: Context) => Promise<void>) =>
      async (ctx: Context): Promise<void> => {
        const restored = await restoringAnswers(alteration, origin, async () => await half(ctx));

        if (restored === 0) {
          throw new Error(
            `\`${source.name}\` ran on ${server.name} without meeting the change its ` +
              `alterations expect: ${alteration.differs}. Remove the entry, and its note ` +
              `below spec 2's second table.`,
          );
        }
      };

    return "runWithout" in source
      ? {
          ...source,
          run: restoring(async (ctx) => await source.run(ctx)),
          runWithout: restoring(async (ctx) => await source.runWithout(ctx)),
        }
      : { ...source, run: restoring(async (ctx) => await source.run(ctx)) };
  });
}

/**
 * Runs `half` with a `fetch` that restores the changed answers from `origin` and hands every
 * other answer over as it came, the storage's among them. A case sends its own requests
 * with the global `fetch` (spec 14.8), so that is the one place to undo the change. Resolves
 * to the number of answers restored.
 */
async function restoringAnswers(
  alteration: ServerAlteration,
  origin: string,
  half: () => Promise<void>,
): Promise<number> {
  const sent = globalThis.fetch;
  let restored = 0;

  globalThis.fetch = async (input, init) => {
    const answer = await sent(input, init);
    const request = typeof input === "string" || input instanceof URL ? undefined : input;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (new URL(url).origin !== origin) return answer;

    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = alteration.restore(method, answer);

    if (headers === undefined) return answer;

    restored += 1;

    return new Response(answer.body, {
      status: answer.status,
      statusText: answer.statusText,
      headers,
    });
  };

  try {
    await half();
  } finally {
    globalThis.fetch = sent;
  }

  return restored;
}
