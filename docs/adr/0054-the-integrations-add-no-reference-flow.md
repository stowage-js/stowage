# The integrations add no reference flow

ADR 0004 shaped the core API against five reference flows, and each flow is a call sequence against
that API: what goes into `put`, `get`, `list` or `presignPut`, what comes out, and what has to hold.
`@stowage/http` (ADR 0046) and the three integrations (ADR 0047) add no operation to that API. They
take a storage and call it, and three of their answers are flows that already exist, carried through
a framework route: `acceptUpload` is flow 1, `presignUpload` is flow 2, and `serveObject` is flow 4,
the worker answering a client's `GET` and passing its `Range` on. So v0.5 keeps the five flows and
adds none.

What the HTTP layer promises on top of those calls, its statuses and headers, already has a place of
its own: the layer's section of the spec, ADR 0048 and ADR 0049 for the rules, and the HTTP
conformance suite with the second table of the runtime matrix for what is supported (ADR 0050). New
flows for serving, uploading and presigning through a route were weighed, and they would have stated
the same promises a third time, with `flow/*` cases in the HTTP suite beside the cases that already
assert them. Rewriting flows 1, 2 and 4 as routes was weighed as well, and it would have taken the
flows away from the script writing through `adapter-fs` and from the worker without a framework,
which are the callers ADR 0004 drew them for.

Flow 3, a handler serving one page of a listing, has no answer in the layer. A listing over HTTP
needs a response format, JSON with objects, prefixes and a cursor, and the layer would then promise
that format to every client, which is the protocol ADR 0049 refused to define for `presignUpload`.
The caller writes the few lines that turn a `page()` into the JSON its own client reads.

## Consequences

- Section 3 keeps five flows. Flows 1, 2 and 4 each gain one line, "Through a route", naming the
  function of `@stowage/http` that carries it and linking the layer's section: `acceptUpload` for
  flow 1, `presignUpload` for flow 2, and for flow 4 `serveObject`, with `redirectToObject` as the
  alternative that hands ranges to the provider. The line promises nothing of its own; each flow's
  "Holds when" and "Fails as" stay as they are.
- Section 14.6 keeps its five `flow/*` cases. The cases of the HTTP conformance suite carry no
  `flow/` prefix and are named after the answer they request, `serve/`, `redirect/`, `upload/` and
  `presign/`, the four values of `url(answer, key)` on an `HttpConformanceTarget`.
- Section 17 names a listing endpoint in `@stowage/http` as a non-goal.
- `CONTEXT.md` sharpens Reference flow to a call sequence against a storage, which a route carries.
- This extends ADR 0004 and contradicts none of it. No released promise changes, so ADR 0017 is not
  touched.
- A case name is unique within its list, so the HTTP case `presign/put` and the conformance case
  `presign/put` of spec 14.5 are two cases of two lists. `describeHttpConformance` opens a
  `describe` of its own, named `<name> over HTTP`, so that a run holding both keeps them apart.
