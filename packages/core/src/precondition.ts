import type { CapabilityName } from "./capabilities.ts";
import type { Refusal } from "./errors.ts";

/**
 * Visible ASCII without `"`: what a strong entity tag of RFC 9110 holds between its quotes.
 * A leading `W/` marks a weak tag, which compares as no strong validator (ADR 0070).
 */
const etagPattern = /^[\x21\x23-\x7E]+$/u;

const formsOn = { write: '`"absent"` or `{ etag }`', delete: "`{ etag }`" } as const;

function isEtag(value: unknown): boolean {
  return typeof value === "string" && etagPattern.test(value) && !value.startsWith("W/");
}

/**
 * The checks of spec 4.3 for `onlyIf`, in order: `Unsupported` naming the capability the form
 * needs, then `InvalidOption` naming `onlyIf`. `undefined` where the value passes. The form
 * decides the capability, so on a write a string needs `writeIfAbsent` and an object
 * `writeIfUnchanged` whatever they hold, on `delete` an object needs `deleteIfUnchanged`, and
 * any other value is `InvalidOption` on every storage (ADR 0076). `"absent"` has no kind on
 * `delete`, so a string there is `InvalidOption` before any capability decides (ADR 0070).
 */
export function preconditionRefusal(
  onlyIf: unknown,
  on: "write" | "delete",
  capabilities: readonly CapabilityName[],
): Refusal | undefined {
  if (onlyIf === undefined) return undefined;

  const needed = capabilityFor(onlyIf, on);

  if (needed !== undefined && !capabilities.includes(needed)) {
    return {
      code: "Unsupported",
      message: `This storage does not hold the precondition \`${needed}\` names`,
      capability: needed,
    };
  }

  if (isWellFormed(onlyIf, on)) return undefined;

  // The message names the option and never the value it refused (spec 4.3).
  return {
    code: "InvalidOption",
    message: `The option \`onlyIf\` takes ${formsOn[on]}, an \`etag\` of visible ASCII without \`"\` and without a leading \`W/\``,
  };
}

/** The capability the form of the value needs, `undefined` for a value of no form. */
function capabilityFor(onlyIf: unknown, on: "write" | "delete"): CapabilityName | undefined {
  if (typeof onlyIf === "string") return on === "write" ? "writeIfAbsent" : undefined;
  if (typeof onlyIf === "object" && onlyIf !== null) {
    return on === "write" ? "writeIfUnchanged" : "deleteIfUnchanged";
  }

  return undefined;
}

function isWellFormed(onlyIf: unknown, on: "write" | "delete"): boolean {
  if (onlyIf === "absent") return on === "write";
  if (typeof onlyIf !== "object" || onlyIf === null) return false;

  const keys = Object.keys(onlyIf);

  return keys.length === 1 && keys[0] === "etag" && isEtag(Reflect.get(onlyIf, "etag"));
}
