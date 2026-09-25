/**
 * Every capability a storage can declare (spec 4.9). The list grows in minor releases, so a
 * `switch` over it needs a default branch.
 *
 * - `keyBytesPreserved`: a key comes back byte for byte as it was written. Where not
 *   declared, it comes back Unicode-equivalent.
 * - `presignedUrls`: the concrete type carries `presignGet` and `presignPut`. Where not
 *   declared, neither method exists on the type.
 * - `rangeReads`: `get` honors `range`. Where not declared, a `range` is `Unsupported`.
 * - `userMetadata`: `put` stores `userMetadata` whose keys are ASCII identifiers,
 *   `[A-Za-z_][A-Za-z0-9_]*`; `stat` and `get` return it, `copy` keeps it. Where not declared,
 *   a non-empty `userMetadata` is `Unsupported` and reads return `{}`.
 * - `userMetadataTokenKeys`: beside `userMetadata`, a key may be any ASCII HTTP token, such as
 *   `content-hash`. Where not declared, a key outside identifiers is `Unsupported` naming it;
 *   without `userMetadata` too, the call is `Unsupported` naming that.
 */
export const capabilityNames = [
  "keyBytesPreserved",
  "presignedUrls",
  "rangeReads",
  "userMetadata",
  "userMetadataTokenKeys",
] as const;

/** One name out of {@link capabilityNames}. */
export type CapabilityName = (typeof capabilityNames)[number];
