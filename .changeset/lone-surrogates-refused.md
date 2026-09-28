---
"@stowage/core": minor
"@stowage/conformance": minor
---

**Breaking:** a key or a user metadata value holding a lone surrogate is now refused, where `adapter-memory` and `adapter-fs` used to accept it. A lone surrogate is no Unicode character and has no UTF-8 form, so `adapter-fs` stored such a key with `U+FFFD` in its place and `adapter-s3` failed with a `URIError`. `invalidKeyReason` refuses it as `InvalidKey` under `writable`, `addressable` and `prefix`, and `checkUserMetadata` refuses such a value with `InvalidRequest` before it measures the 2 KB (spec 4.3, 4.8, ADR 0010). The conformance suite adds a key holding a lone high and a lone low surrogate to `put/refused-keys`, such a value to `put/user-metadata-limits`, and the case `get/refused-keys`, which asserts the refused addressable list of spec 9.7 against `get`, `stat` and `exists` (#189).
