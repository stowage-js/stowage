---
"@stowage/adapter-fs": minor
---

A `put`, `copy` or `move` that fails removes the directories it created on the way to the destination, where they stayed empty, so a listing with a delimiter shows no pseudo-directory that holds nothing. A directory that was there before the write stays (spec 6, #161). A `put` now creates its directories and its temporary file under the lock a `delete` prunes under, so a `put` running beside a `delete` in the same directory no longer fails with `NotFound` when the prune removed the directory it had just found.
