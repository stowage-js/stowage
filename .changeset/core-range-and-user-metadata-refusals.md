---
"@stowage/core": minor
---

Add the range rules and the user metadata checks of spec 4.3 for adapter authors: `rangeBoundsRefusal`, `rangeStartRefusal`, `lastByteOf`, `rangeCoversWhole`, `rangeHeader`, `wholeSizeOf` and `checkUserMetadata`. Each answers with a `Refusal`, the code, message and capability of the failure, and leaves raising the `StorageError` to the adapter (spec 4.13, ADR 0019).
