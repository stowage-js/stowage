---
"@stowage/nestjs": minor
"@stowage/hono": minor
"@stowage/nextjs": minor
---

Each integration promises the major of its framework current at its release and the runtimes that framework promises: NestJS 12 on Node, Hono 4 on Node, Bun, Deno and `workerd`, Next.js 16 on Node. A later major is added in a minor release once CI covers it, and the peer range widens to hold both. A major its framework no longer supports leaves the way a Node line at end of life does, without a breaking release: Next.js's at the end of its Maintenance LTS, NestJS's and Hono's when the next major is released. Dropping a major its framework still supports, and raising a peer range's floor, are withdrawals (spec 1, 15, ADR 0047, ADR 0050).
