import { type FirstRunPoint, type FirstRunTest, firstRunSuite } from "../../s3/src/first-run.ts";
import { azureBlobAccount } from "./divergences.ts";

/** The block `describeCases` registers the cases against the endpoint in. */
const azureBlobSuite = "@stowage/adapter-azure-blob";

/** The block `adapter-azure-blob.test.ts` holds the account key against the endpoint in. */
const accountKeySuite = "adapter-azure-blob against the endpoint";

export const azureProbeNames = {
  responseOverrides: "a presigned `GET` answers with the three response overrides",
  commitTwice: "a `Put Block List` sent twice answers `201` both times with the same bytes",
  putBlobDiscards: "a `Put Blob` discards the uncommitted blocks of its name",
  expiredUrlCors: "the `403` for an expired presigned `PUT` carries the CORS headers of the rule",
  longNameOnHead: "a name above 1,024 characters is answered `InvalidKey` by `stat` and `exists`",
  copyAboveLimit: "`copy` of a source above 5,000 MiB",
  staleMarker: "a `marker` Azure does not continue from",
  unicodeEquivalentNames: "an NFC and an NFD name",
  refusedWritableKeys: "the three kinds of writable key spec 8.1 refuses",
  flowOneOnWorkerd: "flow/1-large-upload measured on workerd",
} as const;

const account = [azureBlobAccount];

const probe = (title: string): FirstRunTest => ({ suite: firstRunSuite, title });
const conformanceCase = (title: string): FirstRunTest => ({ suite: azureBlobSuite, title });

/**
 * Spec 13 on `adapter-azure-blob` as it stood before the first run against the account,
 * point by point, with what the scheduled run reads each one off, and the question ADR 0023
 * has the run settle for flow 2. A point stated as a promise holds or is disproved; one
 * recorded or one that may loosen a rule reads what the run observed.
 */
export const azureBlobFirstRunPoints: readonly FirstRunPoint[] = [
  {
    promise: "Azure Blob: a writable key holding `U+FFFE` is stored and listed as written",
    tests: [conformanceCase("list/noncharacter-key")],
    endpoints: account,
  },
  {
    promise:
      "Azure Blob: `Put Blob From URL` copies the user metadata by default, and the bearer header authorizes the source under an access token",
    tests: [conformanceCase("copy/user-metadata"), conformanceCase("copy/round-trip")],
    endpoints: account,
  },
  {
    promise: "Azure Blob: the service SAS authorizes the source of a copy under an account key",
    tests: [
      {
        suite: accountKeySuite,
        title: "Shared Key signs a copy whose source carries a service SAS",
      },
    ],
    endpoints: account,
    runtime: "node",
  },
  {
    promise:
      "Azure Blob: the three response overrides on `presignGet` are answered as the response headers",
    tests: [probe(azureProbeNames.responseOverrides)],
    endpoints: account,
    runtime: "node",
  },
  {
    promise:
      "Azure Blob: a `Put Block List` sent twice answers `201` both times with the same bytes, and a `Put Blob` discards the uncommitted blocks of its name",
    tests: [probe(azureProbeNames.commitTwice), probe(azureProbeNames.putBlobDiscards)],
    endpoints: account,
    runtime: "node",
  },
  {
    promise:
      "Azure Blob: a name above 1,024 characters is answered with `400` on a `HEAD` too, so `stat` and `exists` report `InvalidKey`",
    tests: [probe(azureProbeNames.longNameOnHead)],
    endpoints: account,
    runtime: "node",
  },
  {
    promise:
      "Azure Blob: the 17 MiB upload of flow 1 on `workerd` stays within a paid plan's duration and CPU limits",
    tests: [probe(azureProbeNames.flowOneOnWorkerd)],
    endpoints: account,
    runtime: "workerd",
  },
  {
    promise:
      "Azure Blob: the `403` for an expired presigned URL carries the CORS headers of the rule, after a preflight from its origin (ADR 0023)",
    tests: [probe(azureProbeNames.expiredUrlCors)],
    endpoints: account,
    runtime: "node",
  },
  {
    promise: "Azure Blob, recorded: the code of the `409` for a copy source above 5,000 MiB",
    tests: [probe(azureProbeNames.copyAboveLimit)],
    endpoints: account,
    // The service's limit is no property of the Node line, so one line uploads the 5,000 MiB.
    runtime: "node-24",
  },
  {
    promise:
      "Azure Blob, recorded: the code that answers a `marker` Azure no longer continues from",
    tests: [probe(azureProbeNames.staleMarker)],
    endpoints: account,
    runtime: "node",
  },
  {
    promise: "Azure Blob, may add: whether an NFC and an NFD name are one object or two",
    tests: [probe(azureProbeNames.unicodeEquivalentNames)],
    endpoints: account,
    runtime: "node",
  },
  {
    promise:
      "Azure Blob, may loosen: whether the three kinds of writable key spec 8.1 refuses need refusing",
    tests: [probe(azureProbeNames.refusedWritableKeys)],
    endpoints: account,
    runtime: "node",
  },
];
