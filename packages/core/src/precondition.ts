import type { CapabilityName } from "./capabilities.ts";
import type { Refusal } from "./errors.ts";

/**
 * Visible ASCII without `"`: what a strong entity tag of RFC 9110 holds between its quotes.
 * A leading `W/` marks a weak tag, which compares as no strong validator (ADR 0070).
 */
const etagPattern = /^[\x21\x23-\x7E]+$/u;

function isEtag(value: unknown): boolean {
  return typeof value === "string" && etagPattern.test(value) && !value.startsWith("W/");
}

/**
 * The checks of spec 4.3 for `onlyIf`, in order: `Unsupported` naming the capability the form
 * needs, then `InvalidOption` naming `onlyIf`. `undefined` where the value passes. The form
 * decides the capability, so a string needs `writeIfAbsent` and an object `writeIfUnchanged`
 * whatever they hold, and any other value is `InvalidOption` on every storage (ADR 0076).
 */
export function preconditionRefusal(
  onlyIf: unknown,
  on: "write",
  capabilities: readonly CapabilityName[],
): Refusal | undefined {
  if (onlyIf === undefined) return undefined;

  const needed = capabilityFor(onlyIf);

  if (needed !== undefined && !capabilities.includes(needed)) {
    return {
      code: "Unsupported",
      message: `This storage does not hold the precondition \`${needed}\` names`,
      capability: needed,
    };
  }

  if (isWellFormed(onlyIf)) return undefined;

  // The message names the option and never the value it refused (spec 4.3).
  return {
    code: "InvalidOption",
    message:
      'The option `onlyIf` takes `"absent"` or `{ etag }`, an `etag` of visible ASCII without `"` and without a leading `W/`',
  };
}

/** The capability the form of the value needs, `undefined` for a value of neither form. */
function capabilityFor(onlyIf: unknown): CapabilityName | undefined {
  if (typeof onlyIf === "string") return "writeIfAbsent";
  if (typeof onlyIf === "object" && onlyIf !== null) return "writeIfUnchanged";

  return undefined;
}

function isWellFormed(onlyIf: unknown): boolean {
  if (onlyIf === "absent") return true;
  if (typeof onlyIf !== "object" || onlyIf === null) return false;

  const keys = Object.keys(onlyIf);

  return keys.length === 1 && keys[0] === "etag" && isEtag(Reflect.get(onlyIf, "etag"));
}
