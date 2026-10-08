---
"@stowage/core": minor
---

`PutOptions` takes `cacheControl`, `contentDisposition` and `contentLanguage`, and `ObjectStat` reports them as optional members, missing where the object holds no value. `capabilityNames` gains `contentHeaders`, first in its order. `isHeaderValue`, `ContentHeaders`, `ContentHeadersCheck` and `checkContentHeaders` give an adapter the checks of spec 4.3 for the three, in their order, and hand back a frozen snapshot of what passed for the adapter to send: `Unsupported` where the storage does not declare `contentHeaders`, the form as `InvalidOption`, then 2,048 bytes of header names and values with `Content-Type` and 100 characters of `contentLanguage` as `InvalidRequest` (ADR 0058, ADR 0060).
