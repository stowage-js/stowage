import type { CaseOf } from "../../../packages/conformance/src/case.ts";

/**
 * One HTTP case a runtime's own server answers otherwise than the layer handed it the
 * answer: it sets or drops a header on its way to the socket, which no answer of the layer
 * can prevent. Unlike an emulator's divergence (ADR 0012), it is what a client of that
 * cell sees, so spec 2 names each one below its second table.
 */
export interface ServerDivergence {
  /** The HTTP case the difference shows up in. */
  readonly case: string;
  /** What the server does to the answer. */
  readonly differs: string;
  /** Part of the message the case fails with, so that another failure still reads as one. */
  readonly failureMessagePart: string;
}

/**
 * The cases as a run against `server` performs them: a case with an entry passes where it
 * fails as the entry says, and fails where it passes, so that a runtime release that stops
 * changing the answer reaches the list and spec 2 instead of going unnoticed.
 */
export function withServerDivergences<Context>(
  sources: readonly CaseOf<Context>[],
  server: { readonly name: string; readonly divergences?: readonly ServerDivergence[] },
): readonly CaseOf<Context>[] {
  return sources.map((source) => {
    const divergence = server.divergences?.find((entry) => entry.case === source.name);

    if (divergence === undefined) return source;

    const expecting = (half: (ctx: Context) => Promise<void>) =>
      expectingFailure(divergence, server.name, half);

    return "runWithout" in source
      ? {
          ...source,
          run: expecting(async (ctx) => await source.run(ctx)),
          runWithout: expecting(async (ctx) => await source.runWithout(ctx)),
        }
      : { ...source, run: expecting(async (ctx) => await source.run(ctx)) };
  });
}

function expectingFailure<Context>(
  divergence: ServerDivergence,
  server: string,
  half: (ctx: Context) => Promise<void>,
): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    try {
      await half(ctx);
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);

      if (message.includes(divergence.failureMessagePart)) return;

      throw thrown;
    }

    throw new Error(
      `\`${divergence.case}\` passed on ${server}, whose divergences expect it to fail: ` +
        `${divergence.differs}. Remove the entry, and its note below spec 2's second table.`,
    );
  };
}
