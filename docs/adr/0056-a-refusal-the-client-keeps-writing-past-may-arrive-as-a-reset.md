# A refusal the client keeps writing past may arrive as a reset

ADR 0049 has `acceptUpload` refuse a body without reading it: a `Content-Length` above `maxSize` is
`413` before the body is read, and a body passing `maxSize` while it streams is `413` once the count
passes. What becomes of the rest of that body belongs to the server the layer runs in, not to the
layer, which hands back a `Response` and never sees a socket (ADR 0046). On `workerd` that server is
KJ's: it sends the response, discards up to 64 KiB of the unread body or for up to one second, and
then drops the connection without a half-close (workerd 1.20261004.1, capnproto
`c++/src/kj/compat/http.c++`, cloudflare/workerd#7634). A client still writing meets a reset, and
undici's `fetch` rejects with `write ECONNRESET` or `EPIPE` whenever its next body write fails
before its parser reads the `413` already waiting in the socket's buffer. `upload/max-size` failed
so once, on `@stowage/hono` on `workerd` (#346). A probe of `acceptUpload` on `workerd` under the
`fetch` of Node 24 failed so in 46 of 400 `PUT`s of 1048577 bytes with a `Content-Length`, and in
none of 400 such bodies sent as a stream, whose bytes the layer has read before it refuses them.
Node's `http` server drains an unread body after the response and showed no reset.

So the layer promises the answer it hands back, not its delivery: a client still sending a body the
layer refused may meet a reset connection instead, as the runtime decides. RFC 9112 asks a server
to close in stages for exactly this case (section 9.6) and lets it close after the response rather
than read the body (section 9.3); neither is the layer's to do. Draining the body in the layer was
weighed. It would make the `413` arrive on `workerd`, and it would turn `maxSize` into a bill for
bandwidth instead of memory, which is the open bill ADR 0049 made `maxSize` required against.
Promising delivery would have made every reset a defect of stowage that only the runtime can
repair. The Node bridge keeps letting an unread body flow and dropping it, so that Deno's
`node:http` reaches the next request on the connection, but that is how it works and not what it
promises.

The HTTP conformance suite asserts what a client observes, and a client writing past a refusal may
observe a reset. `upload/max-size` therefore accepts, for its `PUT` of 1048577 bytes with a
`Content-Length`, either a `413` or a `fetch` rejected as a network error, and asserts the object
unchanged after both. Its streamed `PUT` keeps requiring the `413`, so a server that never delivers
one still fails the case. A network error is any `TypeError` `fetch` rejects with: the cases run
under the `fetch` of Node, Bun and Deno, and a code such as `ECONNRESET` is undici's addition, which
a list of codes would bind the published case to. Moving the `Content-Length` request into a
repository test over a raw socket, as ADR 0050 does for a body that contradicts its length, was
weighed, and it would have stopped checking a third party's server for that `413` at all. Repeating
the request until a `413` arrives, in the case or through a Vitest `retry`, would hide a refusal
that fails now and then for a reason of its own.

## Consequences

- Spec 10.2 states beside the layer's own refusals that the layer promises the answer and not its
  delivery: a client still sending a body the layer answered without reading, or refused while it
  streamed, may meet a reset connection instead. It holds for every refusal made before the body is
  read, `405`, `415` and the `400`s among them, not for `413` alone. Section 10.5 points to it.
- Spec 14.9's row for `upload/max-size` reads that 1048577 bytes as bytes answer `413` or fail as a
  network error, as a stream without a length answer `413`, and that the object reads back
  unchanged.
- `CONTEXT.md` adds to HTTP layer that it promises the answer it hands back, not its delivery.
- The sentence of spec 10.2 is a minor release of `@stowage/http`, and the change to the case a
  minor release of `@stowage/conformance`; neither changeset is marked breaking (ADR 0017). The
  spec never promised delivery, a client met the reset before a sentence stated it, and a server
  that passed the case still passes it.
- No retry is configured for the HTTP conformance suite, neither in a case, nor in a harness, nor in
  Vitest.
- This extends ADR 0049 and ADR 0050 and contradicts neither.
- cloudflare/workerd#7634 tracks the reset on `workerd`. The case does not depend on whether or when
  it is fixed.
