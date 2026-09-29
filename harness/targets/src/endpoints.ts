import type { Variables } from "../../s3/src/configuration.ts";

/**
 * The endpoint tiers of ADR 0012, ADR 0023 and ADR 0034, named after their harness
 * directories.
 */
const endpointTiers = ["s3", "azure-blob", "gcs"] as const;

export type EndpointTier = (typeof endpointTiers)[number];

const variable = "STOWAGE_CONFORMANCE_ENDPOINTS";

const noTier = "none";

/**
 * The endpoint tiers a run asks for, from a comma-separated list; every one where the list
 * is unset. A scheduled job reaches the one provider its environment holds, so it names
 * that tier, and the other stays out of its run rather than failing its endpoint check
 * (ADR 0012): the check still fails every tier a run asks for and finds unconfigured.
 *
 * `none` asks for no tier, for a machine that cannot start the emulators: GitHub's macOS
 * runners have no Docker, and their jobs run the cells that need no endpoint. It is a name
 * of its own rather than an empty list, because an empty list is what an unset variable
 * reads as, and a run that sets nothing must not skip a tier in silence.
 */
export function endpointTiersFrom(variables: Variables): ReadonlySet<EndpointTier> {
  const listed = variables[variable] ?? "";

  if (listed === "") return new Set(endpointTiers);

  const names = listed.split(",").map((name) => name.trim());

  if (names.includes(noTier)) {
    if (names.length > 1) {
      throw new Error(
        `\`${variable}\` names \`${noTier}\` beside a tier, and \`${noTier}\` stands alone`,
      );
    }

    return new Set();
  }

  return new Set(
    names.map((name) => {
      const tier = endpointTiers.find((each) => each === name);

      if (tier === undefined) {
        throw new Error(
          `\`${variable}\` names ${JSON.stringify(name)}, which is none of ${endpointTiers.join(", ")}`,
        );
      }

      return tier;
    }),
  );
}
