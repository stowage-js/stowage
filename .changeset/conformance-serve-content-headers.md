---
"@stowage/conformance": minor
---

The HTTP suite gains `serve/content-language`, `serve/stored-disposition` and `serve/stored-cache-control`, each requiring `contentHeaders` and seeding its object through `put`. A stored `de-AT` is answered as `Content-Language` to `GET`, to `HEAD` and on a `304`; a stored `attachment; filename="stored.pdf"` is answered as stored, and a stored `inline; filename="x.html"` as `attachment` with the key's last segment; a stored `public, max-age=60` leaves the `serve` route's `private, no-cache` as it is. Without `contentHeaders`, an object written without the three is answered without `Content-Language` and with the defaults (spec 14.9, ADR 0064).
