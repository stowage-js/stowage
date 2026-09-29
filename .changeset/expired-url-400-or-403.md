---
"@stowage/conformance": patch
---

`presign/expired-url` accepts `400` or `403` for the expired URL, as spec 10.5 states, where it required `403`. GCS answers an expired V4 presigned URL with `400 ExpiredToken`, where S3, R2 and Azure answer `403` (spec 9.9). The case also signs a URL with `expiresIn: 60` beside the expired one and requires it to answer `200` after the same wait, so that a URL broken for another reason fails rather than passing as expired (ADR 0035).
