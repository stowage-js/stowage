---
"@stowage/conformance": minor
---

**Breaking:** `serve/whole` and `serve/head` assert `Content-Length` equal to the size, where v0.5 asserted none. A server that drops the length of a `200` or of its `HEAD` fails them now: a third-party server on `workerd`, which sends every stream body chunked, or one on `Bun.serve` whose body still streams when the headers go out, passed them before and has no list of server alterations to undo the change with. This asserts more of a target than v0.5 did, a conflict with ADR 0017 (spec 14.9, ADR 0064).
