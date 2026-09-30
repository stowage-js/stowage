---
"@stowage/core": minor
---

**Breaking:** `get` no longer promises one round trip. Spec 4.5 promised that `stat` comes from the response carrying the body and that `get` costs one round trip; it now promises that `stat` describes the object whose bytes the body carries, and each adapter states what `get` costs: one request on `adapter-s3` and `adapter-azure-blob`, two sent side by side on `adapter-gcs`, and at most two more, one after the other, where a writer replaced the object between them. The media download of GCS carries no user metadata, so no request of the JSON API answers with both. This conflicts with ADR 0017, under which a provider promised later does not narrow the parity core: the number of requests states a cost, not a behavior a storage keeps or does not, so no capability can carry it, and the promise is withdrawn instead. No code of another adapter changes (spec 4.5, 11, ADR 0032, ADR 0040).
