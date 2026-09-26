import type { Variables } from "../../s3/src/configuration.ts";

/** The endpoint tiers of ADR 0012 and ADR 0023, named after their harness directories. */
const endpointTiers = ["s3", "azure-blob"] as const;

export type EndpointTier = (typeof endpointTiers)[number];

const variable = "STOWAGE_CONFORMANCE_ENDPOINTS";

/**
 * The endpoint tiers a run asks for, from a comma-separated list; every one where the list
 * is unset. A scheduled job reaches the one provider its environment holds, so it names
 * that tier, and the other stays out of its run rather than failing its endpoint check
 * (ADR 0012): the check still fails every tier a run asks for and finds unconfigured.
 */
export function endpointTiersFrom(variables: Variables): ReadonlySet<EndpointTier> {
  const listed = variables[variable] ?? "";

  if (listed === "") return new Set(endpointTiers);

  return new Set(
    listed.split(",").map((name) => {
      const tier = endpointTiers.find((each) => each === name.trim());

      if (tier === undefined) {
        throw new Error(
          `\`${variable}\` names ${JSON.stringify(name)}, which is none of ${endpointTiers.join(", ")}`,
        );
      }

      return tier;
    }),
  );
}
