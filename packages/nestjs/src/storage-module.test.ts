import {
  type INestApplicationContext,
  Inject,
  Injectable,
  Module,
  type Type,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { memoryStorage } from "@stowage/adapter-memory";
import { expect, test } from "vitest";

import { StorageModule } from "./index.ts";

const avatars = Symbol("avatars");
const documents = Symbol("documents");

/** A class written as `@Module(metadata) class … {}` would be, without decorator syntax. */
function moduleOf(metadata: Parameters<typeof Module>[0]): Type {
  // oxlint-disable-next-line no-extraneous-class -- NestJS reads a module from its metadata alone
  class TestModule {}

  Module(metadata)(TestModule);

  return TestModule;
}

/** A provider that takes the storage under `token` through `@Inject(token)`. */
function consumerOf(token: symbol): Type<{ readonly storage: unknown }> {
  class Consumer {
    readonly storage: unknown;

    constructor(storage: unknown) {
      this.storage = storage;
    }
  }

  Injectable()(Consumer);
  Inject(token)(Consumer, undefined, 0);

  return Consumer;
}

async function contextOf(root: Type): Promise<INestApplicationContext> {
  // NestJS aborts the process on a failed initialization unless told otherwise.
  return await NestFactory.createApplicationContext(root, { abortOnError: false, logger: false });
}

test("`forRoot` registers the storage it was given under `provide`, as it is", async () => {
  const storage = memoryStorage();
  const context = await contextOf(
    moduleOf({ imports: [StorageModule.forRoot({ provide: avatars, storage })] }),
  );

  expect(context.get(avatars)).toBe(storage);
  await context.close();
});

test("a registration is global by default, so a feature module injects it without an import", async () => {
  const storage = memoryStorage();
  const Consumer = consumerOf(avatars);
  const feature = moduleOf({ providers: [Consumer] });
  const context = await contextOf(
    moduleOf({ imports: [StorageModule.forRoot({ provide: avatars, storage }), feature] }),
  );

  expect(context.get(Consumer, { strict: false }).storage).toBe(storage);
  await context.close();
});

test("`global: false` keeps the token from a module that does not import the registration", async () => {
  const feature = moduleOf({ providers: [consumerOf(avatars)] });
  const root = moduleOf({
    imports: [
      StorageModule.forRoot({ provide: avatars, storage: memoryStorage(), global: false }),
      feature,
    ],
  });

  await expect(contextOf(root)).rejects.toThrow(/can't resolve dependencies/iu);
});

test("`global: false` hands the token to the module that imports the registration", async () => {
  const storage = memoryStorage();
  const Consumer = consumerOf(avatars);
  const context = await contextOf(
    moduleOf({
      imports: [StorageModule.forRoot({ provide: avatars, storage, global: false })],
      providers: [Consumer],
    }),
  );

  expect(context.get(Consumer).storage).toBe(storage);
  await context.close();
});

test("two registrations hold two storages under two tokens", async () => {
  const first = memoryStorage();
  const second = memoryStorage();
  const context = await contextOf(
    moduleOf({
      imports: [
        StorageModule.forRoot({ provide: avatars, storage: first }),
        StorageModule.forRoot({ provide: documents, storage: second }),
      ],
    }),
  );

  expect([context.get(avatars), context.get(documents)]).toEqual([first, second]);
  expect(context.get(avatars)).not.toBe(context.get(documents));
  await context.close();
});

test("`forRootAsync` registers what its factory resolves with, built from `inject` and `imports`", async () => {
  const bucket = Symbol("bucket");
  const configuration = moduleOf({
    providers: [{ provide: bucket, useValue: "avatars" }],
    exports: [bucket],
  });
  const storage = memoryStorage();
  const handed: unknown[] = [];
  const context = await contextOf(
    moduleOf({
      imports: [
        StorageModule.forRootAsync({
          provide: avatars,
          imports: [configuration],
          inject: [bucket],
          useFactory: async (name: unknown) => {
            handed.push(name);

            return await Promise.resolve(storage);
          },
        }),
      ],
    }),
  );

  expect(context.get(avatars)).toBe(storage);
  expect(handed).toEqual(["avatars"]);
  await context.close();
});

test("`forRootAsync` is global by default and keeps its token with `global: false`", async () => {
  const globalContext = await contextOf(
    moduleOf({
      imports: [
        StorageModule.forRootAsync({ provide: avatars, useFactory: () => memoryStorage() }),
        moduleOf({ providers: [consumerOf(avatars)] }),
      ],
    }),
  );

  await globalContext.close();

  await expect(
    contextOf(
      moduleOf({
        imports: [
          StorageModule.forRootAsync({
            provide: avatars,
            useFactory: () => memoryStorage(),
            global: false,
          }),
          moduleOf({ providers: [consumerOf(avatars)] }),
        ],
      }),
    ),
  ).rejects.toThrow(/can't resolve dependencies/iu);
});

// Spec 11: a storage holds nothing to release (spec 4.1), so the module hooks into nothing.
test("the module has no lifecycle hook", () => {
  const hooks = [
    "onModuleInit",
    "onApplicationBootstrap",
    "onModuleDestroy",
    "beforeApplicationShutdown",
    "onApplicationShutdown",
  ];

  expect(hooks.filter((hook) => hook in StorageModule.prototype)).toEqual([]);
});
