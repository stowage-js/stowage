# Spike: core API stub (#11)

**Throwaway.** A compiling stub with no implementation behind it, written three ways, plus the
five reference flows of #4 as consumer code against each. The question is not "does it run" but
"which version reads worst".

```sh
npm install
npm run check      # tsc --noEmit, the whole point
```

`shared/data.ts` holds the shapes #11 does not ask about, so the variants differ only where the
ticket has an open question. `expected-failures.ts` is the negative half: every
`@ts-expect-error` there is an assertion that a variant refuses something, and tsc reports an
expectation that does not fire.

## The three variants

|                   | **A — disk** (`a-disk/`)             | **B — client** (`b-client/`)                | **C — registry** (`c-registry/`)          |
| ----------------- | ------------------------------------ | ------------------------------------------- | ----------------------------------------- |
| Bucket            | bound, `withBucket()` clones         | per call, `{ bucket, key }`                 | bound, no clone                           |
| Facade            | `Storage` wraps the adapter          | none, `get()` returns a handle              | none, `get()` returns a handle            |
| `list()`          | `AsyncIterable<ListPage>`            | flat iterable **+** `listPage()`            | one listing, read flat / `pages()` / `page()` |
| Provider options  | generic extension map on the adapter | none in core, only on the concrete client   | registry augmented per provider key       |
| Operation set     | wide: `exists`, `move`, `deleteMany` | narrow: caller writes `exists` and `move`   | middle: `stat() → null`, variadic `delete` |

## What the flows showed

Observations, not decisions. Each is a line of code you can read.

**Bucket binding.** Per-call bucket (B) puts `{ bucket, key }` into every call in all five flows
and invents a bucket for the adapters that have none: in `b-client/flows.ts` flow 5, `"uploads"`
is a bucket on S3 and a directory below the root on fs, the same word for two things. Bound
(A, C) keeps the portable type honest — one storage is one namespace — and costs an object per
bucket. Bucket management fits none of the three: it is a client concern, and a bound storage has
no place to put it.

**Listing.** Flow 3 is the discriminator, because it wants exactly one page. Pages-only (A) makes
the handler open the iterator by hand and throw it away: `pages[Symbol.asyncIterator]().next()`,
plus a `done` branch that exists only to satisfy the type. Flow 5 wants the opposite — every object, no cursor —
and there A reads fine while a flat-only API would leave flow 3 without a cursor at all. B pays
with two methods, C with one object that reads three ways.

**Provider options.** Proved, not argued:

- A's generic map needs four slots filled by every adapter, and it collapses: `StorageAdapter<any>`
  infers `any`, so the portable facade accepts `{ storageKlass: 42, whatever: null }` without a
  complaint. Type safety lasts exactly as long as the concrete adapter type reaches the call site.
- B's closed core refuses every provider option on the portable type, which is the honest version
  of the same rule, and keeps generics out of the core entirely. Provider options exist only where
  the concrete client type is in hand.
- C's registry gives the same refusal on the portable type and keeps the option typed on the bound
  one, with no generic parameter on the interface. The cost is global augmentation and a provider
  key per adapter — and #27 has R2 and S3 sharing a wire protocol, so which key R2 claims is a
  question this design forces.

**Facade.** A's facade repeats every parity-core method, so every change is made twice, and
presigning sits outside it: flow 2 reaches past the facade to the adapter. The handle (B, C) also
removes a round trip that A cannot avoid — flow 4 needs the content type for the response header,
and A's `get()` returns the body alone, so it calls `stat()` first. Nothing in the five flows asks
for a multi-disk manager; flow 5 holds two storages as two constants.

**Which operations earn their place.** `exists` written by the caller (B) is a `try`/`catch` that
swallows whichever error class #14 has not defined yet. `move` written by the caller gets the
failure window wrong, and inside one adapter it is a server-side copy plus a delete. `deleteMany`
is used by none of the five flows; `deleteAll(prefix)` is used by flow 5. `stat() → null` (C)
removes `exists` at the price of a silent missing-object case at every call site.

## D — what was decided (`d-chosen/`)

Not one of A, B or C: the half of each that survived reading the flows. It is written as two
files, `core.ts` and `adapter-s3.ts`, because the package boundary is part of the answer.

- **Bucket bound at construction, no clone.** Another bucket is another storage.
- **No facade.** `get()` hands back a handle carrying the stat from the same response, which is
  what removes A's second round trip in flow 4.
- **One listing, two readings.** Flat for flow 5, `.page()` for flow 3. `pages()` is gone: no
  reference flow used it.
- **The core is closed.** No generic parameter, no registry, no index signature. Provider options
  live on `S3Storage`, which widens `put` and adds the presigning the parity core does not have.
  The portable type refuses `storageClass`, refuses an unknown option, and has no `presignGet` —
  all three asserted in `expected-failures.ts`.
- **`stat()` throws, `exists()` asks.** The throwing path belongs to #14.
- **`delete()` is variadic** and always returns a report; `deleteAll(prefix)` stays beside it.
- **No bucket management.** Not parity core; if it comes, it comes as a separate client per
  provider.
