import { assert } from "../assertions.ts";

/**
 * The body of an answer, after its status was checked. The body is read either way, so
 * that no case leaves a connection to the server open behind a body it did not want.
 */
export async function expectStatus(
  response: Response,
  status: number,
  what: string,
): Promise<Uint8Array> {
  const body = new Uint8Array(await response.arrayBuffer());

  assert(response.status === status, `${what} answers ${response.status} and not ${status}`);

  return body;
}

/** An answer with no body at all, which a `HEAD`, a `404` and a `405` of spec 10 are. */
export async function expectEmpty(response: Response, status: number, what: string): Promise<void> {
  const body = await expectStatus(response, status, what);

  assert(body.byteLength === 0, `${what} answers with a body of ${body.byteLength} bytes`);
}

/** A header of an answer, `null` for one it does not carry, named by the request in `what`. */
export function assertHeaderOf(
  response: Response,
  name: string,
  expected: string | null,
  what: string,
): void {
  const held = response.headers.get(name);

  assert(
    held === expected,
    `${what} carries \`${name}: ${JSON.stringify(held)}\` and not ${JSON.stringify(expected)}`,
  );
}

/** A network error `fetch` rejected with, named by the request it failed. */
export class UnansweredRequest extends Error {
  override readonly name = "UnansweredRequest";
}

/**
 * What `fetch` settles with: its answer, or the network error it rejected with. That error
 * names no request, so it comes back as the cause of one naming the request in `what`.
 */
export async function answerOrNetworkError(
  sending: Promise<Response>,
  what: string,
): Promise<Response | UnansweredRequest> {
  try {
    return await sending;
  } catch (failure) {
    if (failure instanceof TypeError)
      return new UnansweredRequest(`${what} fails as a network error`, { cause: failure });

    throw failure;
  }
}

/** The answer `fetch` resolves with, its network error thrown as one naming the request. */
export async function answerTo(sending: Promise<Response>, what: string): Promise<Response> {
  const answer = await answerOrNetworkError(sending, what);

  if (answer instanceof UnansweredRequest) throw answer;

  return answer;
}
