---
"@stowage/conformance": minor
---

The HTTP conformance suite: `describeHttpConformance(target, framework)` runs `httpConformanceCases` against a server through an `HttpConformanceTarget`, inside a `describe` named `<name> over HTTP`, with the run of spec 14.2 (spec 14.8, ADR 0050). Its first cases serve a whole object, one range of it and the preconditions, and redirect to a presigned URL: `serve/whole`, `serve/headers`, `serve/disposition`, `serve/head`, `serve/not-found`, `serve/method-not-allowed`, `serve/range`, `serve/suffix-range`, `serve/unsatisfiable-range`, `serve/ignored-range`, `serve/if-none-match`, `serve/if-modified-since`, `serve/if-match`, `serve/if-unmodified-since`, `serve/if-range`, `redirect/found`, `redirect/head` and `redirect/method-not-allowed` (spec 14.9).
