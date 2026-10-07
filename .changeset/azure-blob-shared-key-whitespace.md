---
"@stowage/adapter-azure-blob": patch
---

`adapter-azure-blob` signs every `x-ms-` header value under Shared Key trimmed and otherwise as sent, a tab and a run of spaces included. It folded each run of whitespace to one space, which Azure refuses with `403 AuthenticationFailed`: a streamed `put` of more than one part whose `contentType` held two spaces failed under an account key (ADR 0059).
