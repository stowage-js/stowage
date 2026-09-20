# A key is validated and never rewritten

`@stowage/core` checks a key against a rule and throws `InvalidKey` before the adapter sends a
request. It does not change a key to make it acceptable. The prior art surveyed in the research
that produced this question does the opposite in both directions: `unstorage` rewrites `/` to `:`
and drops everything after a `?`, and `flydrive` restricts keys to `/^[A-Za-z0-9-_!\/\.\s]*$/`,
which is narrower than S3 permits. Rewriting is the worse of the two, because the caller gets no
error and no object under the key they passed. Passing keys through untouched was the third
option, and it makes the same key mean two things: `a/../b` is an object of that name on S3 and
the object `b` on a file system, which the parity core exists to rule out.

One key space holds for every adapter, and an adapter may refuse more than it. The rule below is
the part every adapter carries, so a key that works against `adapter-memory` works against S3.
Above it, `adapter-fs` refuses a segment longer than 255 bytes, which is what a file system
allows, and reports that as `InvalidKey` as well. The alternative — a core that only refuses what
breaks everywhere, and each adapter defining the rest — moves the question into reference flow 5,
where a prefix moves from `fs` to S3 and the answer arrives halfway through the move.

Strictness depends on whether stowage creates the key or only names one that exists. Writing a
key — `put`, the destination of `copy` and `move`, a presigned `PUT` — takes the full rule.
Addressing a key — `get`, `stat`, `exists`, `delete`, the source of `copy` and `move`, a
presigned `GET` — takes the part of it that protects the request itself: no `..` or `.` as a
segment, no leading `/`, no empty segment, no control characters. Reference flows 3 and 5 read
buckets that stowage did not fill, and a bucket filled by the S3 console holds keys ending in `/`
that stand for pseudo-directories. Under one rule for both, `list` would return keys that `get`
then refuses, which would leave a file browser unable to open what it displays.

A key is a string of Unicode characters whose length is measured in UTF-8 bytes, from 1 to 1024,
which is how S3 measures it. Counting characters instead would place the limit differently
depending on the script a key is written in. Nothing normalizes the Unicode form, which follows
from the first paragraph and costs something concrete on both sides of the parity core: a file
system that stores names in NFD, as APFS does, returns a key in a different form from the one it
was given, and R2, which normalizes to NFC before storing, holds one object where S3 holds two.

There is no allowlist of characters. `#`, `%`, `?`, `+`, a space and any character above ASCII
are all legal in a key, so an adapter has to encode a key itself, segment by segment, and may
never build a request path by handing a key to the `URL` constructor. The three failures are not
edge cases: `new URL("https://host/" + "a/../b").pathname` is `/b`, `q?x=1` loses everything from
the `?`, and `decodeURIComponent` throws on a key containing a bare `%`. The spike on
`spike/sigv4` has the right function in `encodePath` and calls it on a path that a `URL` has
already changed.

## Consequences

- `@stowage/core` exports the check as a function, and every adapter calls it as the first act of
  every operation. The closed interface from ADR 0004 has no base class to put it in, so the
  conformance suite carries the other half: a case for each operation asserting that an invalid
  key produced no request.
- The check rejects the returned promise and never throws synchronously. Every operation is
  async, and a call that sometimes throws before returning a promise forces a caller to write
  both `try` and `catch` around an `await`.
- An invalid key handed to `delete` becomes an entry in `failed` rather than a thrown error, so
  the other keys are still deleted and the caller reads every kind of per-key failure the same
  way, as ADR 0005 describes. `copy` and `move` check source and destination before acting on
  either.
- A writable key holds 1 to 1024 UTF-8 bytes and contains no `..` or `.` as a segment, no leading
  `/`, no empty segment, no trailing `/`, no backslash, and no character in `U+0000`–`U+001F` or
  `U+007F`. A backslash is a separator on Windows and reads as one in any listing; `NUL` is in no
  file name.
- An addressable key drops from that rule the trailing `/`, the backslash and the length limit.
  `list` therefore returns pseudo-directory markers and keys from other tools, and `get`, `delete`
  and the source of a copy accept them.
- A prefix follows the addressable key's rule, and on top of it may be empty, may end on `/`, and
  may end in the middle of a segment. With a prefix longer than 1024 bytes, `list` still exposes
  matching addressable keys created by other tools through both its page and iteration forms.
- `adapter-memory` enforces the core rule exactly, neither more nor less. It is published
  separately because a third-party adapter is read against it, so an adapter that accepted keys
  S3 refuses would teach the wrong rule.
- The conformance suite carries both a list of keys every adapter has to accept and a list it has
  to refuse, in both degrees of strictness. The accepted list holds a character above ASCII, a
  space, `#`, `%`, `?`, `+`, `'`, a single-character key, and a key of 1024 bytes split into
  segments of at most 255 bytes, which is the length a file system can hold. Both lists are cheap
  to run and belong to the tier that runs on every commit.
- A platform is supported where CI covers it, which is the rule ADR 0002 sets for runtimes. v0.1
  runs `adapter-fs` on Linux and macOS and names Windows nowhere, so `adapter-fs` carries no rule
  for reserved names such as `CON`, for `<>:"|*?`, or for a trailing dot. Windows also collides
  `Invoice.pdf` with `invoice.pdf`, which no key rule can repair.
- The Unicode form of a key survives a round trip except where the provider normalizes it:
  `adapter-fs` returns NFD for a key written in NFC on a file system that stores names that way,
  and `adapter-s3` against R2 holds one object for two forms S3 keeps apart. Each adapter states
  that in its README, and ADR 0014 keeps v0.1 from promising which of the two happens. An adapter
  that does keep the bytes says so through `keyBytesPreserved`, the capability ADR 0015 adds for
  it, and neither of these two declares it.
- `adapter-fs` checks on every access that the resolved real path lies under its root, and reports
  `NotFound` when it does not. The key rule cannot see this: a symlink inside the root pointing at
  `/etc` turns an ordinary key into a way out. `NotFound` is the honest answer — the key is valid
  and this storage holds no object there — and it tells the caller nothing about the file system
  below. Adding an eleventh error code for it would reopen the closed union of ADR 0005 for one
  case.
- Loosening the rule later is not a breaking change and tightening it is, because a key that used
  to be written starts throwing. The v0.1 rule therefore refuses everything the parity core cannot
  carry today, rather than starting permissive.
