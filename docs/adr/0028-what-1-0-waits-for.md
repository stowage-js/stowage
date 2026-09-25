# 1.0 waits until the spec holds no promise a real endpoint has not answered

ADR 0017 makes 1.0 wait for six things, and four of them are points a real endpoint had to answer
first. The reason is the price of a correction: below 1.0 a promise the first run disproves is
withdrawn in a minor release, and above it the same withdrawal costs a major. Three of the four are
met. The fourth, the `UploadPartCopy` fallback, left the spec before v0.1 was published: section
7.8 rejects a source too large for one request and falls back to nothing, so there is no promise
left to observe. The spec itself never carried the list. Its section on versions already said in
v0.1 that 1.0 waits for the points of the section settled by the first run.

v0.2 fills that section with the points `adapter-s3` owes after ADR 0027 and the points the Azure
adapter owes against the account of ADR 0023. None of them is on ADR 0017's list, and each carries
the same price after 1.0 as the points that are. A named list would need rewriting for every
provider, and one that stopped at ADR 0017's six would leave `U+FFFE` on Azure or the copy default
of `Put Blob From URL` to cost a major. Gating on the section as it stands was the other
alternative, and the section holds more than promises by now: some points only record what a
provider answers, such as how R2 encodes a space in a listing, and some would only add a promise or
loosen a refusal, such as NFC against NFD for `keyBytesPreserved`. Waiting for those gains nothing,
since neither kind can end in a withdrawal.

1.0 waits until the section holds no promise that a real endpoint has not answered, besides the
`raw` escape hatch and the author's own use of stowage, which no measurement settles. A promise
leaves the section in one of two ways: a scheduled run observes it and it moves to the section it
belongs to, or it is withdrawn. The second way keeps the gate closable. R2's `ExpiredRequest` is
skipped until a way to provoke it exists, and if none turns up, withdrawing it before 1.0 costs a
minor release rather than holding 1.0 back for good.

This amends the list of ADR 0017. The rule replaces its four measured points, and its last two
stay as they are.

## Consequences

- Section 13 of the spec holds three lists: the promises, which the gate waits for; what a run only
  records; and what a run may add or loosen. A point states which list it is on by where it stands.
- A promise is a point a run could disprove against what the spec says to a caller today. Flow 1 on
  `workerd` against Azure counts, although its result can only change the host note of section 2,
  because ADR 0017 counted the same measurement on S3. The `409` code of a copy above 5,000 MiB and
  the code for a stale `marker` only record, since the spec already maps both without them.
- A new provider's open points join the gate by landing in section 13, and nothing in section 10
  changes for them.
- Section 10 says that 1.0 waits until section 13 holds no promise, besides a shape for the `raw`
  escape hatch and the author having used stowage in a project of their own.
