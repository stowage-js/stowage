import { type NodeRequest, type NodeResponse, toWebRequest, writeResponse } from "@stowage/http";

// Spec 11: the platforms are told apart by shape, so that neither `express` nor `fastify`
// becomes a peer. An Express request and response are Node's own; Fastify wraps both and
// hands them over as `raw`.

interface FastifyRequest {
  readonly raw: NodeRequest;
}

interface FastifyReply {
  readonly raw: NodeResponse;
  hijack(): unknown;
}

const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

function isNodeRequest(value: unknown): value is NodeRequest {
  return isObject(value) && isObject(value["headers"]) && typeof value["on"] === "function";
}

function isNodeResponse(value: unknown): value is NodeResponse {
  return (
    isObject(value) &&
    typeof value["setHeader"] === "function" &&
    typeof value["write"] === "function"
  );
}

function isFastifyRequest(value: unknown): value is FastifyRequest {
  return isObject(value) && isNodeRequest(value["raw"]);
}

function isFastifyReply(value: unknown): value is FastifyReply {
  return isObject(value) && typeof value["hijack"] === "function" && isNodeResponse(value["raw"]);
}

function nodeRequestOf(req: unknown): NodeRequest {
  if (isFastifyRequest(req)) return req.raw;
  if (isNodeRequest(req)) return req;

  throw new TypeError("`req` is neither an Express request nor a Fastify request");
}

function nodeResponseOf(res: unknown): NodeResponse {
  if (isFastifyReply(res)) return res.raw;
  if (isNodeResponse(res)) return res;

  throw new TypeError("`res` is neither an Express response nor a Fastify reply");
}

/**
 * The web `Request` for the request a handler took through `@Req()`, an Express request or
 * a Fastify request, with the response it took through `@Res()`, whose closing early aborts
 * the request's signal. A body a parser already read is a `TypeError`.
 */
export function webRequestOf(req: unknown, res: unknown): Request {
  return toWebRequest(nodeRequestOf(req), nodeResponseOf(res));
}

/**
 * Writes `response` into the response a handler took through `@Res()`, an Express
 * response or a Fastify reply, which it hijacks first so that Fastify sends nothing of its
 * own. Resolves once the response has ended or the client left.
 */
export async function sendResponse(res: unknown, response: Response): Promise<void> {
  if (isFastifyReply(res)) res.hijack();

  await writeResponse(nodeResponseOf(res), response);
}
