// The one function of the `Deno` namespace the harness calls, for the repository's type
// check, which runs on Node. Deno reads its own declarations and never this file.
declare namespace Deno {
  function test(name: string, fn: () => Promise<void>): void;
}
