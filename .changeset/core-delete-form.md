---
"@stowage/core": minor
---

`@stowage/core` exports `isOneKeyWithOptions`, which tells the form of `delete` for one key, `delete(key, options)`, from the variadic one, and its argument type `OneKeyWithOptions`. Every adapter in this repository calls it. It is not part of the spec and may change in any minor release, as `sendRequest` may.
