/** Which Node APIs a worker reaches, as the worker reports it. */
export interface NodeApiReach {
  readonly process: string;
  readonly Buffer: string;
  readonly "node:os": ImportOutcome;
  readonly "node:buffer": ImportOutcome;
}

export type ImportOutcome = "loaded" | "rejected";

export async function nodeApiReach(): Promise<NodeApiReach> {
  return {
    process: typeof process,
    Buffer: typeof Buffer,
    "node:os": await importOutcome("node:os"),
    "node:buffer": await importOutcome("node:buffer"),
  };
}

// The specifier arrives as a parameter so the bundler neither resolves nor externalizes
// it, and the import reaches `workerd` as written.
async function importOutcome(specifier: string): Promise<ImportOutcome> {
  try {
    await import(specifier);

    return "loaded";
  } catch {
    return "rejected";
  }
}
