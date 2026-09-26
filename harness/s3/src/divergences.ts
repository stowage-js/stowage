import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import type { ConformanceContext } from "../../../packages/conformance/src/target.ts";
import type { Emulator, RealEndpoint } from "./configuration.ts";

/**
 * ADR 0012: one conformance case an emulator answers differently from the provider it
 * stands in for. The harness expects the case to fail against that endpoint alone, and the
 * same case run against `settledBy` in the `slow` tier is what keeps the entry honest.
 */
export interface Divergence<
  Endpoint extends string = Emulator,
  Settling extends string = RealEndpoint,
> {
  /** The conformance case the difference shows up in. */
  readonly case: string;
  readonly endpoint: Endpoint;
  /** What the emulator does differently. */
  readonly differs: string;
  /** Part of the message the case fails with, so that another failure still reads as one. */
  readonly failureMessagePart: string;
  /** The real endpoint that runs the same case. */
  readonly settledBy: Settling;
  /** Where the difference is tracked upstream, telling a bug being fixed from an intent. */
  readonly upstream?: string;
}

// Kept in the private harness and never in `@stowage/conformance`: it describes an
// endpoint this repository happens to test against, not the API an adapter implements.
export const divergences: readonly Divergence[] = [];

/**
 * The cases as a run against `endpoint` performs them: a case with an entry for that
 * endpoint passes where it fails as the entry says, and fails where it passes, so that an
 * upstream fix reaches the list at the next image update instead of going unnoticed.
 */
export function withDivergences(
  sources: readonly ConformanceCaseSource[],
  endpoint: string | undefined,
  list: readonly Divergence<string, string>[] = divergences,
  listedIn = "harness/s3/src/divergences.ts",
): readonly ConformanceCaseSource[] {
  return sources.map((source) => {
    const divergence = list.find(
      (entry) => entry.case === source.name && entry.endpoint === endpoint,
    );

    if (divergence === undefined) return source;

    const run = expectingFailure(divergence, listedIn, async (ctx) => await source.run(ctx));

    return "runWithout" in source
      ? {
          ...source,
          run,
          runWithout: expectingFailure(
            divergence,
            listedIn,
            async (ctx) => await source.runWithout(ctx),
          ),
        }
      : { ...source, run };
  });
}

function expectingFailure(
  divergence: Divergence<string, string>,
  listedIn: string,
  half: (ctx: ConformanceContext) => Promise<void>,
): (ctx: ConformanceContext) => Promise<void> {
  return async (ctx) => {
    try {
      await half(ctx);
    } catch (thrown) {
      if (messageOf(thrown).includes(divergence.failureMessagePart)) return;

      throw thrown;
    }

    throw new Error(
      `\`${divergence.case}\` passed against ${divergence.endpoint}, which the divergence ` +
        `list expects to fail: ${divergence.differs}. Remove the entry from \`${listedIn}\`.`,
    );
  };
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
