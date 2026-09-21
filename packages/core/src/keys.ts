export type KeyRule = "writable" | "addressable" | "prefix";

const writableKeyLimit = 1024;

const utf8 = new TextEncoder();

/** The reason a key violates the rule, or `undefined` where it holds. */
export function invalidKeyReason(key: string, rule: KeyRule): string | undefined {
  // The empty prefix stands for every object in the storage (spec 4.8).
  if (key === "") return rule === "prefix" ? undefined : "is empty";

  const controlCharacter = firstControlCharacter(key);

  if (controlCharacter !== undefined) return `holds the control character ${controlCharacter}`;

  // The three requirements an addressable key and a prefix drop, so that a bucket
  // filled by another tool stays reachable (spec 4.8).
  if (rule === "writable") {
    if (key.includes("\\")) return "holds a backslash";
    if (key.endsWith("/")) return "ends with a slash";

    const bytes = utf8.encode(key).length;

    if (bytes > writableKeyLimit) {
      return `is ${bytes} UTF-8 bytes, above the limit of ${writableKeyLimit}`;
    }
  }

  return invalidSegmentReason(key);
}

function firstControlCharacter(key: string): string | undefined {
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);

    if (code <= 0x1f || code === 0x7f) {
      return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }

  return undefined;
}

function invalidSegmentReason(key: string): string | undefined {
  const segments = key.split("/");

  for (const [index, segment] of segments.entries()) {
    if (segment === "." || segment === "..") return `holds ${JSON.stringify(segment)} as a segment`;

    if (segment !== "") continue;
    if (index === 0) return "starts with a slash";
    // A trailing slash reaches this point only where the rule allows it.
    if (index < segments.length - 1) return "holds an empty segment";
  }

  return undefined;
}
