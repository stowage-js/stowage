---
"@stowage/adapter-azure-blob": minor
---

**Breaking:** `adapter-azure-blob` no longer reads a range of an object another tool stored with a content coding. Such a range read a truncated prefix on Node, a broken body on Bun and `workerd`, and the stored bytes on Deno. Where the answer to a ranged `get` names a `Content-Encoding` other than `identity`, the body is canceled and `get` rejects with `ProviderError` naming the coding, also where the range covers the whole object, as on `adapter-gcs`. A start at or beyond the stored size stays `InvalidRequest`, since the `416` names no coding. A `get` without `range` still reads what `fetch` hands over, which may be longer than `size`, the stored size (spec 4.3, 4.4, 8.2, ADR 0044).
