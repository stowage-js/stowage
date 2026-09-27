---
"@stowage/conformance": patch
---

`errors/bad-credentials` accepts `InvalidCredentials` with `attempts` of `1` or `2`, as spec 9.5 states, where it required `1`. An adapter that refreshes a refused access token once, as `adapter-azure-blob` does, spends a second attempt before it gives up (ADR 0021).
