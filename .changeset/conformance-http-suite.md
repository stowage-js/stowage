---
"@stowage/conformance": minor
---

The HTTP conformance suite: `describeHttpConformance(target, framework)` runs `httpConformanceCases` against a server through an `HttpConformanceTarget`, inside a `describe` named `<name> over HTTP`, with the run of spec 14.2 (spec 14.8, ADR 0050). Its first cases serve a whole object: `serve/whole`, `serve/headers`, `serve/disposition`, `serve/head`, `serve/not-found`, `serve/method-not-allowed` and `serve/ignored-range` (spec 14.9).
