---
"@stowage/core": minor
---

`ObjectStat` reports `contentEncoding`, the content coding an object is stored with, as stored. It is missing where the object holds no coding, an empty value or `identity` in any case, and it names how the object is stored, not which bytes `get` hands over. `contentEncodingOf` turns a stored value into the member, and `contentCodingRefusal` shares its definition of a coding (ADR 0061).
