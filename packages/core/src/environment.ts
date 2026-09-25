/**
 * ADR 0007: `process.env` is the one route through Node, Bun, Deno's compatibility layer
 * and a Worker under `nodejs_compat`. A Worker without it has no `process` at all, and
 * Deno without `--allow-env` throws `NotCapable` rather than answering `undefined`, so
 * both leave the value empty. A name is read on its own, because enumerating
 * `process.env` needs the unscoped permission in Deno.
 */
export function readEnvironment(name: string): string {
  try {
    if (typeof process === "undefined") return "";

    return process?.env?.[name] ?? "";
  } catch {
    return "";
  }
}

declare const process: { readonly env?: Readonly<Record<string, string | undefined>> } | undefined;
