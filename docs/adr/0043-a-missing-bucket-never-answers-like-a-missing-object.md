# A missing bucket never answers like a missing object, and is `NotFound` without `key`

ADR 0038 had `exists` on `adapter-gcs` rethrow a missing bucket rather than answer `false`: a wrong
bucket name is a configuration error, and an `exists` that reads it as an absent object hides it
behind an answer that looks right. That holds for every provider, and ADR 0038 left
`adapter-s3` and `adapter-azure-blob` answering `false` only because aligning them was outside its
map. `adapter-fs` already refuses the same way for a root that is gone. This makes it one rule: on
every adapter, an operation against a missing bucket rejects. `exists` never answers `false` for it
and `delete` never returns a report for it. Where the provider names the bucket as missing, the
error is `NotFound` without `key`, the shape ADR 0037 and ADR 0038 gave it on GCS and that
`adapter-fs` gives a missing root. `adapter-memory` has no bucket to miss.

The points were measured on 2026-09-30 on Node 24 against the AWS bucket, the R2 bucket and the
Azure account of the scheduled run, signed with each one's read credential, beside a bucket and a
container named at random.

On S3 a `HEAD` cannot tell. AWS answers `404` to a `HEAD` of an absent key and to a `HEAD` in a
missing bucket with the same headers and no code, and a `HEAD` carries no body. So `stat` and
`exists` in `adapter-s3` answer a `404` to their `HEAD` with a second request, a `GET` of the same
key with `Range: bytes=0-0`. It needs `s3:GetObject`, as the `HEAD` does, and its body names
`NoSuchKey` or `NoSuchBucket`, measured on AWS. Only `NoSuchBucket` changes the answer. Any other
answer leaves the `HEAD`'s answer standing, whether that is `NoSuchKey`, a success or a `416`
because a writer created the object in between, or a body without a code from a compatible
endpoint. ADR 0038 already lets a read that races a writer answer `NotFound`, and a compatible
endpoint is not promised (ADR 0041), so it keeps the `false` it gets today. A hit still costs one
request. An absent key costs two, which spec 11 does not count, since the number of requests is a
promise for `get` alone. `HEAD /`, HeadBucket, was the other follow-up. Without `s3:ListBucket`
AWS answers it with a `403` carrying `x-amz-bucket-region` for a bucket that exists, which is a
second way of reading a permission, and nothing measured it on R2. Sending the ranged `GET` in place
of the `HEAD` was the third option. It meets a `416` on every empty object, and `stat` still needs
the `HEAD`'s headers.

R2 does not name the bucket. Under a token scoped to one bucket, the token Cloudflare offers for a
single bucket and the one measured, R2 answers `403 AccessDenied` to a `HEAD`, a `GET`, a listing and a
`DeleteObjects` in any other bucket, missing or not. `adapter-s3` detects no provider (spec 7.2) and
a `403` is also a real refusal, so it stays `AccessDenied`. `exists` already rethrows that, so the
rule that a missing bucket never looks like an absent object holds on R2 too. Only the code differs,
and that is a point of the provider's row in spec 7.2. Nothing measured an account-wide token.

Azure names the container on every path. A `HEAD` carries `x-ms-error-code: ContainerNotFound`, as
spec 8.4 assumed. A Blob Batch `delete` in a missing container answers `202`, and every subresponse
is `404 ContainerNotFound`. Today each such subresponse becomes an entry in `failed`. Under this
rule a `ContainerNotFound` among the subresponses rejects the whole `delete` with `NotFound` without
`key`. A report of 256 identical failures hides a configuration error the same way an `exists` that
answers `false` does.

A code of its own, such as `BucketNotFound`, was the alternative to `NotFound` without `key`. Adding
a name to `StorageErrorCode` is a minor (ADR 0017), but `adapter-gcs` and `adapter-fs` answer a
missing bucket with `NotFound` today, and moving them to the new name would be a withdrawal on
adapters that already do what this decides. Spec 4.10 already reads `NotFound` as "no object under
the key, or no bucket", and an unset `key` is what tells the two apart.

No capability carries the rule, since every adapter with a bucket can tell. A provider promised
later that cannot tell gets a capability its adapter does not declare, as ADR 0017 has it for
anything a new provider cannot hold.

## Consequences

- Spec 4.10 states one rule: an operation against a missing bucket rejects, `exists` rethrows it,
  and `delete` rejects rather than reporting. The error is `NotFound` without `key` where the
  provider names the bucket as missing. The sentence that states the rule per adapter goes.
- Spec 7.9 describes the ranged `GET` that follows a `404` to the `HEAD` of `stat` and `exists`,
  and that only `NoSuchBucket` changes the answer. Spec 7.2 gains a row: under a token scoped to
  other buckets, R2 answers a missing bucket with `403 AccessDenied`. Spec 8.4 says that a
  `ContainerNotFound` subresponse rejects the whole `delete`. Spec 6 already covers the missing
  root, and 4.10 now names it with the others.
- This narrows what the spec promised for two released adapters, which is a conflict with ADR 0017's
  rule that a withdrawal takes something from the caller. `adapter-s3` and `adapter-azure-blob`
  withdraw `false` from `exists` on a missing bucket, and the `key` on its `NotFound` from every
  operation. `adapter-azure-blob` also withdraws the report of `delete` in a missing container. The
  change is a minor below 1.0, and its changeset starts with `**Breaking:**`.
- It replaces the consequence of ADR 0038 that `adapter-s3` and `adapter-azure-blob` do not change.
  The rest of ADR 0038 stands.
- `ConformanceTarget` gains an optional `createStorageWithMissingBucket?()`, which is no breaking
  change (spec 11). A case `errors/missing-bucket` in the `fast` tier then checks that `put`, `get`,
  `stat`, `exists`, `delete` and the first page of `list` reject, and that `key` is unset where the
  code is `NotFound`. `adapter-memory` leaves the factory out, and the case is skipped for it. A new
  case is a minor.
- The emulators have not been measured. The per-commit run shows what SeaweedFS, Azurite and
  fake-gcs-server answer, and any divergence joins the list of ADR 0012, ADR 0023 and ADR 0034.
  The tests of `adapter-gcs` against a stubbed `fetch` from ADR 0038 stay.
- No new point joins spec section 14. Everything the rule relies on on AWS, R2 and Azure was
  measured.
