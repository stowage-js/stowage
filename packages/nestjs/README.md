# @stowage/nestjs

The NestJS integration of stowage: `StorageModule.forRoot({ provide, storage })` registers a
storage under the caller's injection token, and a controller answers through `@stowage/http`
with `webRequestOf(req, res)` and `sendResponse(res, response)`, on Express and on Fastify.

## Install

In a NestJS 12 application, install the integration, the HTTP layer and an adapter:

```sh
npm install @stowage/nestjs @stowage/core @stowage/http @stowage/adapter-memory
```

## Example

This Express application stores uploads in memory and serves them under the same key. Compile
with `experimentalDecorators: true` and `erasableSyntaxOnly: false`, as a NestJS application does.

```ts
import "reflect-metadata";
import { Controller, Get, Inject, Module, Param, Put, Req, Res } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { memoryStorage } from "@stowage/adapter-memory";
import type { Storage } from "@stowage/core";
import { acceptUpload, serveObject } from "@stowage/http";
import { sendResponse, StorageModule, webRequestOf } from "@stowage/nestjs";
import type { Request, Response } from "express";

const storageToken = Symbol("objects");

@Controller("objects")
class ObjectsController {
  constructor(@Inject(storageToken) private readonly storage: Storage) {}

  @Get(":id")
  async get(@Param("id") id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await sendResponse(
      res,
      await serveObject(this.storage, `objects/${id}`, webRequestOf(req, res)),
    );
  }

  @Put(":id")
  async put(@Param("id") id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const response = await acceptUpload(this.storage, `objects/${id}`, webRequestOf(req, res), {
      maxSize: 10 * 1024 * 1024,
    });
    await sendResponse(res, response);
  }
}

@Module({
  imports: [StorageModule.forRoot({ provide: storageToken, storage: memoryStorage() })],
  controllers: [ObjectsController],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { bodyParser: false });
await app.listen(3000);
```

Use `@Res()` without `passthrough`: `sendResponse` sends the web `Response` and completes the
reply. The controller also works on Fastify with the parser setup below, its parameters typed as
`FastifyRequest` and `FastifyReply` there; `webRequestOf` and `sendResponse` take either. Each registration holds
one storage under your token; `global` defaults to `true`. Set `global: false` to keep the token
to the importing module.

## Runtimes

Node 24 and later, with the peer `@nestjs/common` `^12.1.2`. Its floor is 12.1.2, and at this
release CI ran 12.1.2 as the newest release of NestJS 12, each on Node 24 and Node 26.

| Platform          | Node | Bun | Deno | `workerd` |
| ----------------- | ---- | --- | ---- | --------- |
| NestJS on Express | yes  | no  | no   | no        |
| NestJS on Fastify | yes  | no  | no   | no        |

These are the package's cells in the
[runtime matrix](https://github.com/stowage-js/stowage/blob/@stowage/nestjs@0.5.0/docs/spec.md#2-runtime-matrix).
Bun and Deno are not promised, as NestJS promises neither.

The bundle measures 0.5 kB minified and gzipped without NestJS, and 1.8 kB with `@stowage/http`,
which it calls.

## Limits

None.

## Notes

### Keep upload bodies unread

`webRequestOf(req, res)` must run before anything consumes the body. A body parser or validator
that reads it first causes a `TypeError`. On Express, disable Nest's default body parsers with
`NestFactory.create(AppModule, { bodyParser: false })`, as in the example, so JSON uploads reach
`acceptUpload` as bytes. Otherwise Nest's JSON parser may consume the upload or reject it at its
own size limit.

### Fastify parser setup

Install `@nestjs/platform-fastify` for a Fastify application. Before listening and before any
handler calls `webRequestOf`, remove the built-in parsers and register a parser that leaves the
payload unread. Fastify's `application/json` and `text/plain` parsers otherwise take precedence
over `*`, even with Nest's `bodyParser: false`.

Use this function to start your `AppModule` in place of the Express bootstrap above:

```ts
import "reflect-metadata";
import type { Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";

async function bootstrap(AppModule: Type): Promise<void> {
  const adapter = new FastifyAdapter();
  adapter.getInstance().removeAllContentTypeParsers();
  adapter.getInstance().addContentTypeParser("*", (_req, _payload, done) => done(null));

  const app = await NestFactory.create(AppModule, adapter, { bodyParser: false });
  await app.listen(3000);
}
```

This parser setup applies across the application and bypasses Fastify's `bodyLimit`. Use
`acceptUpload`'s `maxSize`, as the controller does, to enforce the upload size limit. Routes that
need parsed bodies must arrange their own parsing. `sendResponse` calls `reply.hijack()` itself.

### Async registration with injected configuration

`forRootAsync` accepts `imports` and `inject`; its factory receives the injected providers in
order and returns a storage or a promise of one. For example, after installing
`@stowage/adapter-fs`:

```ts
import { Module } from "@nestjs/common";
import { fsStorage } from "@stowage/adapter-fs";
import { StorageModule } from "@stowage/nestjs";

const storageToken = Symbol("objects");
const rootToken = Symbol("storage root");

@Module({
  providers: [{ provide: rootToken, useValue: "/tmp/stowage-objects" }],
  exports: [rootToken],
})
class StorageConfigModule {}

const registration = StorageModule.forRootAsync({
  provide: storageToken,
  imports: [StorageConfigModule],
  inject: [rootToken],
  useFactory: (root: string) => fsStorage({ root }),
});
```

Add `registration` to your application's module imports. `provide` and `global` belong beside
`useFactory`; the factory returns the storage itself.

### Replace a storage in tests

On the `TestingModuleBuilder` returned by `Test.createTestingModule` from `@nestjs/testing`, call
`overrideProvider(storageToken).useValue(memoryStorage())` before `compile()`. Use the same token
that your application registered and injects. Each test can supply a fresh memory storage; the
integration provides no separate fake or `forTesting` module.

## Specification

[`docs/spec.md` at `@stowage/nestjs@0.5.0`](https://github.com/stowage-js/stowage/blob/@stowage/nestjs@0.5.0/docs/spec.md#11-stowagenestjs)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/nestjs@0.5.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/nestjs@0.5.0/docs/adr)
are at the same tag.

## License

MIT
