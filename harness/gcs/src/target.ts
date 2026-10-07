import type { GcsSigner } from "../../../packages/adapter-gcs/src/index.ts";
import { gcsStorage } from "../../../packages/adapter-gcs/src/index.ts";
import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import {
  type ConformanceFramework,
  describeCases,
} from "../../../packages/conformance/src/describe.ts";
import {
  type ConformanceRunOptions,
  selectedCases,
} from "../../../packages/conformance/src/run.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";
import type { Variables } from "../../s3/src/configuration.ts";
import { endpointNameFrom, type GcsEndpoint } from "./configuration.ts";
import { withGcsDivergences } from "./divergences.ts";

/**
 * Spec 14.7 and ADR 0034: GCS refuses the key `list/noncharacter-key` writes (spec 9.1), so
 * the case stays unrun on every GCS endpoint. It is no divergence, since no real endpoint
 * runs it to settle one.
 */
const unrunCases: ReadonlySet<string> = new Set(["list/noncharacter-key"]);

export function gcsCases(options: ConformanceRunOptions): readonly ConformanceCaseSource[] {
  return selectedCases(options).filter((source) => !unrunCases.has(source.name));
}

/**
 * ADR 0034: the service account the URLs name. fake-gcs-server checks no signature, so it
 * names no account that exists.
 */
const emulatorServiceAccount = "fake-gcs-server@stowage.invalid";

/**
 * `adapter-gcs` against the endpoint of ADR 0034. fake-gcs-server checks no credential, so
 * there is no factory for a bad or a denied one, and it takes a key generated for the run to
 * sign with, so that the presigning cases and flow 2 run on every commit.
 */
export function gcsTarget(endpoint: GcsEndpoint): ConformanceTarget {
  const name = "@stowage/adapter-gcs";

  if (endpoint.kind === "bucket") {
    const { options, signer, badCredentials, deniedCredentials } = endpoint;

    return {
      name,

      createStorage: () => gcsStorage({ ...options, signer }),

      createStorageWithBadCredentials: () =>
        gcsStorage({ ...options, credentials: badCredentials }),

      createStorageWithDeniedCredentials: () =>
        gcsStorage({ ...options, credentials: deniedCredentials }),

      createStorageWithMissingBucket: () =>
        gcsStorage({ ...options, signer, bucket: missingBucket() }),
    };
  }

  let signer: Promise<GcsSigner> | undefined;
  const emulatorStorage = async (bucket: string) => {
    signer ??= generatedSigner();

    return gcsStorage({ ...endpoint.options, bucket, signer: await signer });
  };

  return {
    name,

    createStorage: async () => await emulatorStorage(endpoint.options.bucket),

    createStorageWithMissingBucket: async () => await emulatorStorage(missingBucket()),
  };
}

/**
 * ADR 0043: a name drawn for each storage, so that no run and no bucket another one left
 * behind can make it exist.
 */
function missingBucket(): string {
  return `stowage-missing-${crypto.randomUUID()}`;
}

/** A key of Web Crypto's own on every runtime, and never extractable, since nothing reads it. */
async function generatedSigner(): Promise<GcsSigner> {
  const { privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );

  return { serviceAccount: emulatorServiceAccount, privateKey };
}

export const endpointMissing = "No GCS endpoint is configured; see `harness/gcs/README.md`";

/**
 * ADR 0034, after ADR 0012: a run includes this tier and fails where no endpoint is
 * reachable rather than passing with it skipped.
 */
export function describeGcsEndpointCheck(
  framework: ConformanceFramework,
  configured: GcsEndpoint | undefined,
): void {
  framework.test(
    "the GCS endpoint of ADR 0034 is configured (see `harness/gcs/README.md`)",
    async () => {
      if (configured === undefined) throw new Error(endpointMissing);
    },
  );
}

/** The cases as a run against the endpoint `variables` name performs them. */
export function gcsRunCases(
  options: ConformanceRunOptions,
  variables: Variables,
): readonly ConformanceCaseSource[] {
  return withGcsDivergences(gcsCases(options), endpointNameFrom(variables));
}

/** The check above, then the cases as a run against the endpoint `variables` name. */
export function describeGcs(
  framework: ConformanceFramework,
  configured: GcsEndpoint | undefined,
  variables: Variables,
): void {
  describeGcsEndpointCheck(framework, configured);

  if (configured === undefined) return;

  describeCases(gcsRunCases(framework, variables), gcsTarget(configured), framework);
}
