// The two functions of `bun:test` the harness hands over, for the repository's type check,
// which runs on Node and has no `bun-types` to read them from.
declare module "bun:test" {
  export function describe(name: string, body: () => void): void;
  export function test(name: string, body: () => Promise<void>): void;
}
