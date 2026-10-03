# @stowage/nextjs

The Next.js integration of stowage: `lazyStorage(factory)` builds a storage on its first use, so
that `next build` constructs none, and a route handler answers through `@stowage/http`.
