export type PutBody = Uint8Array | string | ReadableStream<Uint8Array>;

export interface OperationOptions {
  signal?: AbortSignal;
}

export interface PutOptions extends OperationOptions {
  contentType?: string;
}

export interface ObjectEntry {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
  readonly etag?: string;
}

export interface ObjectStat extends ObjectEntry {
  readonly contentType: string;
}

export interface StoredObject {
  readonly stat: ObjectStat;
  stream(): ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface Storage {
  readonly provider: string;
  readonly bucket: string;

  put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat>;
  get(key: string, options?: OperationOptions): Promise<StoredObject>;
  stat(key: string, options?: OperationOptions): Promise<ObjectStat>;
  exists(key: string, options?: OperationOptions): Promise<boolean>;
}
