---
"@stowage/conformance": minor
---

The HTTP conformance case `upload/max-size` accepts, for its `PUT` of 1048577 bytes with a `Content-Length`, a `413` or a `fetch` rejected as a network error, since a client still writing past a refusal may meet a reset connection (spec 10.2, ADR 0056). It still requires the `413` for the same bytes sent as a stream, and asserts the stored object unchanged after both (spec 14.9). A server that passed the case still passes it.
