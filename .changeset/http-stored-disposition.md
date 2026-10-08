---
"@stowage/http": minor
---

**Breaking:** `serveObject` answers an object stored with a `contentDisposition` of the type `attachment` with that stored value, where the caller passes neither `filename` nor `disposition`, so that a download is saved under the name stored at `put`. The type is the token before the first `;`, compared without case; a stored `inline`, or a value of any other type, is not sent, and the default stands in its place. In v0.5 the download was always named `filename` or the key's last segment; a caller who wants that name passes `filename`. This narrows what spec 10.3 promised, a conflict with ADR 0017 (spec 10.3, ADR 0062).
