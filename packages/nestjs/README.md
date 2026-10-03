# @stowage/nestjs

The NestJS integration of stowage: `StorageModule.forRoot({ provide, storage })` registers a
storage under the caller's injection token, and a controller answers through `@stowage/http`
with `webRequestOf(req, res)` and `sendResponse(res, response)`, on Express and on Fastify.
