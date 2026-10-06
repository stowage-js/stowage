---
"@stowage/conformance": patch
---

An HTTP upload case whose `fetch` rejects as a network error now fails with an error naming the request, such as "`PUT` of a stream of 1048577 bytes without a length fails as a network error", and carries the rejection as its `cause`. Before, the case failed with `fetch`'s own `TypeError`, which does not say which request it belongs to (#346).
