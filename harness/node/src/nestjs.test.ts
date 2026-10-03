import { env } from "node:process";

import { afterAll, describe, test } from "vitest";

import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { describeServers } from "../../targets/src/http.ts";
import { nestjsOnExpress, nestjsOnFastify } from "../../targets/src/nestjs.ts";

// Spec 2: NestJS's two platforms are two cells, since Express needs the bridge and Fastify
// a content type parser and `reply.hijack()`.
const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;
const close = await describeServers([nestjsOnExpress, nestjsOnFastify], "Node", configured, {
  describe,
  test,
});

afterAll(close);
