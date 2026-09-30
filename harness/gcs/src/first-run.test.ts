import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";

import {
  type GcsConfiguration,
  readConfiguration,
} from "../../../packages/adapter-gcs/src/configuration.ts";
import {
  type GcsAdapterOptions,
  type GcsSigningStorage,
  gcsStorage,
} from "../../../packages/adapter-gcs/src/index.ts";
import { isRefusedToken, readErrorBody } from "../../../packages/adapter-gcs/src/provider-code.ts";
import { objectPath, pinnedTo, send } from "../../../packages/adapter-gcs/src/request.ts";
import {
  isStorageError,
  isTransientStatus,
  type ResolverOptions,
  type StorageError,
} from "../../../packages/core/src/index.ts";
import { firstRunSuite } from "../../s3/src/first-run.ts";
import { bucketOrFail, bucketStorage, type GcsBucket, scheduledBucket } from "./environment.ts";
import type { ExpiringToken } from "./federated-token.ts";
import { gcsProbeNames } from "./first-run.ts";

/* oxlint-disable vitest/valid-title -- the titles are the names the spec 14 report reads,
   kept once in `first-run.ts` for both */

// Spec 14: what only the bucket can answer, asked of it by the scheduled run under the
// service account the suite runs as. fake-gcs-server checks no token and names no answer
// the reference leaves open, so these run against the bucket alone. The requests go through
// the adapter's own paths and failure mapping wherever the adapter can send them.
const scheduled = scheduledBucket();

/**
 * Seconds the expiring token is asked for: short enough to wait out in the `slow` tier,
 * and long enough that a minimum of the token service is unlikely to refuse it.
 */
const tokenLifetime = 60;

/** How long after its expiry the probe keeps asking with a token the bucket still accepts. */
const acceptedPastExpiry = 5 * 60_000;

/** The pause between two requests while the bucket still accepts the expired token. */
const askingEvery = 5000;

const expiryTimeout = 10 * 60_000;

describe.skipIf(scheduled === undefined)(firstRunSuite, () => {
  const prefix = `first-run-${randomUUID()}/`;

  afterAll(async () => {
    await storage().deleteAll(prefix);
  });

  // ADR 0033: only a made-up token was measured, and RFC 6750 gives `invalid_token` to an
  // expired one as well. The answer is recorded whole, so that a signal of its own, such as
  // an `error_description`, shows in the report.
  test(
    gcsProbeNames.expiredToken,
    async ({ task, skip }) => {
      const key = `${prefix}expired-token.txt`;

      await storage().put(key, "read with a token past its expiry");

      const expiring = await bucket()
        .expiringToken(tokenLifetime)
        .catch((refusal: unknown) => {
          task.meta.observed = `no token for ${tokenLifetime} s: ${refusal instanceof Error ? refusal.message : String(refusal)}`;

          return undefined;
        });

      if (expiring === undefined) {
        skip("Google granted no token short enough (ADR 0034)");

        return;
      }

      await new Promise<void>(
        (resolve) => void setTimeout(resolve, Math.max(0, expiring.expiresAt - Date.now())),
      );

      const answer = await answerPastExpiry(key, expiring);

      task.meta.observed = answer.observed;
      expect({ status: answer.status, refusedToken: answer.refusedToken }).toEqual({
        status: 401,
        refusedToken: true,
      });

      // Spec 9.3: the repeat reads that answer and asks the resolver once for a fresh token.
      const refreshes: boolean[] = [];
      const reading = gcsStorage({
        ...bucket().options,
        credentials: async (options?: ResolverOptions) => {
          refreshes.push(options?.forceRefresh === true);

          return options?.forceRefresh === true
            ? await freshToken()
            : { accessToken: expiring.accessToken };
        },
      });

      expect((await reading.stat(key)).key).toBe(key);
      expect(refreshes).toEqual([false, true]);
    },
    expiryTimeout,
  );

  // ADR 0040: the reference names the `404 notFound` of an object that does not exist and no
  // answer for a generation that is gone. `get` reads both pinned requests by it.
  test(gcsProbeNames.replacedGeneration, async ({ task }) => {
    const key = `${prefix}replaced-generation.txt`;

    await storage().put(key, "the generation a writer replaces");
    const replaced = await generationOf(key);

    await storage().put(key, "the generation that replaced it");
    const live = await generationOf(key);

    const resource = await pinnedAnswer(key, replaced, "resource");
    const media = await pinnedAnswer(key, replaced, "media");

    task.meta.observed = `resource: ${resource}; media download: ${media}`;

    // Pinned to the live generation, both answer, so a refusal above is the pin's and not the
    // request's.
    expect(live).not.toBe(replaced);
    expect([
      await pinnedAnswer(key, live, "resource"),
      await pinnedAnswer(key, live, "media"),
    ]).toEqual(["200", "200"]);
    expect({ resource, media }).toEqual({
      resource: "`NotFound`, 404 `notFound`",
      media: "`NotFound`, 404",
    });
  });
});

function bucket(): GcsBucket {
  return bucketOrFail(scheduled);
}

function storage(): GcsSigningStorage {
  return bucketStorage(bucket());
}

function configuration(): GcsConfiguration {
  return readConfiguration(bucket().options);
}

async function freshToken(): Promise<{ accessToken: string }> {
  const credentials: GcsAdapterOptions["credentials"] = bucket().options.credentials;

  return typeof credentials === "function" ? await credentials() : credentials;
}

interface ExpiredAnswer {
  readonly status: number;
  /** Whether spec 9.3 repeats after it: `401` with `error=invalid_token`. */
  readonly refusedToken: boolean;
  readonly observed: string;
}

/**
 * The first answer to the object's resource under `token` that is neither `200` nor
 * transient, or the last one once the bucket kept answering so for `acceptedPastExpiry`. The
 * request is `fetch`'s own, since the adapter would repeat it under a fresh token and hide the
 * answer.
 */
async function answerPastExpiry(key: string, token: ExpiringToken): Promise<ExpiredAnswer> {
  const response = await fetch(`${configuration().origin}${objectPath(configuration(), key)}`, {
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  const body = readErrorBody(await response.text());
  const pastExpiry = (Date.now() - token.expiresAt) / 1000;

  if (
    (response.ok || isTransientStatus(response.status)) &&
    Date.now() < token.expiresAt + acceptedPastExpiry
  ) {
    await new Promise<void>((resolve) => void setTimeout(resolve, askingEvery));

    return await answerPastExpiry(key, token);
  }

  const challenge = response.headers.get("www-authenticate") ?? "(none)";

  return {
    status: response.status,
    refusedToken: isRefusedToken(response),
    observed:
      `${response.status} ${pastExpiry.toFixed(0)} s past the expiry, ` +
      `\`www-authenticate: ${challenge}\`, \`${body.providerCode ?? "(no reason)"}\`: ` +
      (body.message ?? "(no message)"),
  };
}

async function generationOf(key: string): Promise<string> {
  const response = await send(configuration(), {
    method: "GET",
    operation: "stat",
    key,
    path: objectPath(configuration(), key),
  });
  const resource: { readonly generation: string } = await response.json();

  return resource.generation;
}

/**
 * What `objects.get` answers pinned to `generation`, read as the adapter reads it: the
 * resource by its provider code, the media download by its status (spec 9.8).
 */
async function pinnedAnswer(
  key: string,
  generation: string,
  path: "resource" | "media",
): Promise<string> {
  const media = path === "media";

  try {
    const response = await send(configuration(), {
      method: "GET",
      operation: "get",
      key,
      path: objectPath(configuration(), key),
      query: [...(media ? [["alt", "media"] as const] : []), ...pinnedTo(generation)],
      media,
    });

    await response.body?.cancel();

    return String(response.status);
  } catch (thrown) {
    if (!isStorageError(thrown)) throw thrown;

    return describedRefusal(thrown);
  }
}

function describedRefusal(failure: StorageError): string {
  const code = failure.providerCode === undefined ? "" : ` \`${failure.providerCode}\``;

  return `\`${failure.code}\`, ${failure.status}${code}`;
}
