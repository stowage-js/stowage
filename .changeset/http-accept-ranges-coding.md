---
"@stowage/http": minor
---

**Breaking:** `serveObject` sends `Accept-Ranges: bytes` only where the storage declares `rangeReads` and the object has no `contentEncoding`, since no range of a coded object can be served (spec 4.3). It followed `rangeReads` alone in v0.5. A client that read `Accept-Ranges` off one answer as a promise for every object of a storage no longer finds it on a coded one. This narrows what spec 10.3 promised, a conflict with ADR 0017 (spec 10.3, ADR 0062).
