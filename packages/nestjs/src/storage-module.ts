import type {
  DynamicModule,
  ForwardReference,
  InjectionToken,
  OptionalFactoryDependency,
  Type,
} from "@nestjs/common";
import type { Storage } from "@stowage/core";

export interface StorageModuleOptions {
  /** The injection token the storage is registered under, which the application injects. */
  provide: InjectionToken;
  storage: Storage;
  /**
   * Whether every module of the application injects the storage without importing the
   * registration. Defaults to `true`, so that a feature module importing the registration
   * again does not construct a second storage. `false` keeps the token to the importing
   * module.
   */
  global?: boolean;
}

export interface StorageModuleAsyncOptions {
  /** The injection token the storage is registered under, which the application injects. */
  provide: InjectionToken;
  /** Builds the storage itself from the providers `inject` names, in their order. */
  useFactory: (...args: any[]) => Storage | Promise<Storage>;
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  imports?: (Type | DynamicModule | Promise<DynamicModule> | ForwardReference)[];
  /**
   * Whether every module of the application injects the storage without importing the
   * registration. Defaults to `true`, so that a feature module importing the registration
   * again does not construct a second storage. `false` keeps the token to the importing
   * module.
   */
  global?: boolean;
}

/**
 * Registers one storage under the injection token the caller passes; two storages are two
 * registrations. The application injects it with `@Inject(token)`.
 */
// oxlint-disable-next-line no-extraneous-class -- spec 11: NestJS configures what it injects through a module's static methods
export class StorageModule {
  static forRoot({ provide, storage, global = true }: StorageModuleOptions): DynamicModule {
    return {
      module: StorageModule,
      global,
      providers: [{ provide, useValue: storage }],
      exports: [provide],
    };
  }

  static forRootAsync({
    provide,
    useFactory,
    inject = [],
    imports = [],
    global = true,
  }: StorageModuleAsyncOptions): DynamicModule {
    return {
      module: StorageModule,
      global,
      imports,
      providers: [{ provide, useFactory, inject }],
      exports: [provide],
    };
  }
}
