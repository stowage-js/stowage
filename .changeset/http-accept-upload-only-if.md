---
"@stowage/http": minor
---

`AcceptUploadOptions` takes `onlyIf?: Precondition`, the caller's policy, such as a route that never overwrites. The layer passes `put` the one `onlyIf` that satisfies it and the request's `If-Match` and `If-None-Match` together, and answers `412` without `put` where none can and no `400` or `501` answers first: `"absent"` beside an `If-Match`, two different `etag`s, and `{ etag }` beside `If-None-Match: *`. An `If-Match` with several tags or `*` holds beside a caller's `{ etag }` as that `etag` where it names it or is `*`, and is `412` where it does not; without a caller's `{ etag }`, beside `"absent"` too, it stays `501`. An `onlyIf` of the wrong form, checked with `preconditionRefusal`, is `400` before the body is read. An `onlyIf` the caller passes on a storage without the capability stays with `put`, answered `500` (spec 10.1, 10.5, ADR 0075).
