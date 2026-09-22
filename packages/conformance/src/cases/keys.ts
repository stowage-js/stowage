import type { ConformanceContext } from "../target.ts";

const utf8 = new TextEncoder();

/** Spec 8.7 measures a key in UTF-8 bytes, and `adapter-fs` bounds one segment at 255. */
const segmentLimit = 255;

/**
 * The characters spec 4.8 refuses anywhere in a key, at both ends of the range it names
 * and the one above it. They are built from their code points rather than written down,
 * because a source file holding a `U+0000` is one no tool reads as text any more.
 */
const refusedControlCharacters: readonly number[] = [0x00, 0x1f, 0x7f];

/** The byte length spec 4.8 allows a writable key, which two key lists sit on either side of. */
const writableKeyLimit = 1024;

/** The prefix one case writes below, which no other case reads or writes. */
export function prefixFor(ctx: ConformanceContext, caseName: string): string {
  return `${ctx.keyPrefix}${caseName}/`;
}

export function keyFor(ctx: ConformanceContext, caseName: string, name = "object"): string {
  return `${prefixFor(ctx, caseName)}${name}`;
}

/**
 * A key of exactly `bytes` UTF-8 bytes below `prefix`, in segments of at most 255 bytes:
 * the boundary key of spec 8.2 and the over-long key of spec 8.7 are both built here, so
 * that the run's prefix counts toward the length rather than being added to it.
 */
export function keyOfBytes(prefix: string, bytes: number): string {
  const fill = bytes - utf8.encode(prefix).length;

  if (fill < 1) {
    throw new Error(`A key of ${bytes} bytes does not fit below ${JSON.stringify(prefix)}`);
  }

  // Every segment but the last costs the slash that follows it, so the count is what
  // leaves each of them within the limit, and the characters are spread evenly over them.
  const count = Math.ceil((fill + 1) / (segmentLimit + 1));
  const characters = fill - (count - 1);
  const segments = Array.from({ length: count }, (_, index) =>
    "k".repeat(Math.floor(characters / count) + (index < characters % count ? 1 : 0)),
  );

  return `${prefix}${segments.join("/")}`;
}

export interface ConformanceKey {
  /** How spec 8.7 names the key, which is what a failing case reports. */
  readonly label: string;
  readonly key: string;
}

/** The accepted list of spec 8.7, below the prefix of the case that writes it. */
export function acceptedKeys(prefix: string): readonly ConformanceKey[] {
  return [
    ...acceptedNames.map((name) => ({ label: name, key: `${prefix}${name}` })),
    { label: "a key of 1024 bytes", key: keyOfBytes(prefix, writableKeyLimit) },
    { label: "a segment of 255 bytes", key: `${prefix}${"k".repeat(segmentLimit)}` },
  ];
}

const acceptedNames: readonly string[] = [
  "a",
  "hello world.txt",
  "docs/2026/report.pdf",
  "a#b",
  "100%",
  "q?x=1",
  "a+b",
  "it's",
  "Grüße/日本語/ключ.txt",
];

export interface RefusedKey extends ConformanceKey {
  /**
   * Whether `put/refused-keys` asks `exists` about the key once the write was refused,
   * which it then has to answer `false`: the addressable keys of spec 8.7, less the one
   * a provider may refuse to address.
   */
  readonly asksExists: boolean;
}

/**
 * The list of spec 8.7 that `put` refuses, below the prefix of the case wherever the
 * prefix leaves the violated rule as it is: a key that is about the start of a key is
 * given as the spec writes it, and every other one goes below the run's prefix, so that
 * a run against a shared bucket asks `exists` about its own key space alone.
 */
export function refusedWritableKeys(prefix: string): readonly RefusedKey[] {
  return [
    { label: "the empty string", key: "", asksExists: false },
    { label: "/a", key: "/a", asksExists: false },
    { label: "a/", key: `${prefix}a/`, asksExists: true },
    { label: "a//b", key: `${prefix}a//b`, asksExists: false },
    { label: "./a", key: `${prefix}./a`, asksExists: false },
    { label: "a/../b", key: `${prefix}a/../b`, asksExists: false },
    { label: "..", key: `${prefix}..`, asksExists: false },
    { label: "a\\b", key: `${prefix}a\\b`, asksExists: true },
    ...refusedControlCharacters.map((code): RefusedKey => ({
      label: `a key holding U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
      key: `${prefix}a${String.fromCharCode(code)}b`,
      asksExists: false,
    })),
    // Addressable, and still not asked: spec 8.7 leaves a provider free to refuse a key
    // it cannot hold, and S3 answers this one with `KeyTooLongError` rather than `false`.
    {
      label: "a key of 1025 bytes",
      key: keyOfBytes(prefix, writableKeyLimit + 1),
      asksExists: false,
    },
  ];
}
