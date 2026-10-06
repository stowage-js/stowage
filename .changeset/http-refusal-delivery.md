---
"@stowage/http": minor
---

The HTTP layer promises the answer it hands back, not its delivery: a client still sending a body the layer answered without reading, or refused while it streamed, may meet a reset connection instead of the answer, as the runtime decides (spec 10.2, 10.5, ADR 0056). `workerd` drops the connection once a refused body still arrives after it discarded 64 KiB of it or waited one second, and `fetch` may then reject before it reads the `413` already sent.
