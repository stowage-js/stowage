---
"@stowage/conformance": minor
---

Add the conformance case `put/concurrent-writers`. Two streamed `put`s of 17 MiB write to one key, paced through their source streams so that each has sent its parts before either completes. Each may resolve or reject, at least one resolves, and the key holds one writer's object whole (spec 4.11, ADR 0024).
