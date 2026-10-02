# @stowage/hono

The Hono integration of stowage: `withStorage(name, storage)` sets a storage on `c.var[name]`,
and a route answers through `@stowage/http` with `c.req.raw`.
