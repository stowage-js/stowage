import { createServer } from "node:http";
import { env } from "node:process";

import { describe, expect, test } from "vitest";

import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { configuredStorage, endpointOrFail } from "../../s3/src/environment.ts";
import { disconnectDuringGet } from "../../targets/src/disconnect.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { type HttpServer, listening } from "../../targets/src/http.ts";

const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;

/** Short, since a server that keeps the provider's request open fails only at the timeout. */
const closeTimeout = 2_000;

/**
 * A server answering a `GET` with the first chunk of `get`'s stream, read without the
 * request's signal, that hands the reader to `onLeave` once the client left.
 */
function serverThat(
  onLeave: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): HttpServer {
  return {
    name: "a server that does not cancel",
    start: async (storageOptions) => {
      const storage = s3Storage(storageOptions);

      return await listening(
        createServer(async (req, res) => {
          const key = decodeURIComponent(req.url?.split("/").at(-1) ?? "");
          const reader = (await storage.get(key)).stream().getReader();
          const first = await reader.read();

          res.on("close", () => onLeave(reader));
          if (first.value !== undefined) res.write(first.value);
        }),
      );
    },
  };
}

// A check that cannot fail proves nothing: these are the two ways a server can leave the
// provider's request running after the client is gone.
describe.skipIf(configured === undefined)("the disconnect test", () => {
  test("fails a server that reads the object on after the client left", async () => {
    const readsOn = serverThat((reader) => {
      void (async () => {
        // oxlint-disable-next-line no-await-in-loop -- drained to the end on purpose
        while (!(await reader.read()).done);
      })();
    });

    await expect(disconnectDuringGet(readsOn, endpointOrFail(), closeTimeout)).rejects.toThrow(
      /read all \d+ bytes/u,
    );
  }, 30_000);

  test("fails a server that stops reading without canceling", async () => {
    const stopsReading = serverThat(() => {});

    await expect(disconnectDuringGet(stopsReading, endpointOrFail(), closeTimeout)).rejects.toThrow(
      /stayed open/u,
    );
  }, 30_000);
});
