---
"@stowage/adapter-s3": minor
---

**Breaking:** A session token the provider cannot parse is `InvalidCredentials`, where it was `ProviderError` on AWS and `InvalidRequest` on R2. AWS answers it with `400 InvalidToken`, whose message travels word for word. R2 answers it with `400 InvalidArgument` and nothing but `X-Amz-Security-Token` as the message, so the message says "The session token is not one the provider accepts" in front of it, and a continued `list` no longer reads it as a `cursor` the provider refused. No refresh follows either answer, since a fresh credential does not replace a malformed token. This withdraws `InvalidRequest`, and `InvalidOption` naming `cursor`, from R2's answer to a session token it cannot parse (spec 7.3, 7.9).
