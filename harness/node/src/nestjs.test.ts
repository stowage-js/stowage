import { afterAll, describe, test } from "vitest";

import { serverStorage } from "../../s3/src/environment.ts";
import { describeServers } from "../../targets/src/http.ts";
import { nestjsOnExpress, nestjsOnFastify } from "../../targets/src/nestjs.ts";

// Spec 2: NestJS's two platforms are two cells, since Express needs the bridge and Fastify
// a content type parser and `reply.hijack()`.
const configured = serverStorage();
const close = await describeServers([nestjsOnExpress, nestjsOnFastify], "Node", configured, {
  describe,
  test,
});

afterAll(close);
