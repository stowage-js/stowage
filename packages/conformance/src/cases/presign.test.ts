import {
  type ContentHeaders,
  type ObjectStat,
  type Precondition,
  preconditionRefusal,
  type Storage,
  StorageError,
  type StoredObject,
} from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { caseNamed, stubStorage, stubTarget } from "../stubs.ts";
import { controlLifetime, expiredLifetime, pastTheLifetime } from "./presign.ts";

const utf8 = new TextEncoder();

const contentType = "text/plain";

const signedUrl = "https://example.invalid/signed";

/** A header no S3 adapter hands back, standing in for what `adapter-azure-blob` will. */
const blobType = { "x-ms-blob-type": "BlockBlob" };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A storage that declares `presignedUrls` and carries the two methods on the concrete
 * type, the way `S3Storage` does. No adapter of this repository declares the capability
 * yet, so the `run` halves would otherwise be the part of the suite nothing here reads.
 */
const signing = (fields: {
  presignGet?: (key: string, options: { expiresIn: number }) => Promise<string>;
  presignPut?: (key: string, options: { expiresIn: number }) => Promise<unknown>;
}): Storage => {
  const held = new Map<string, string>();

  const describe = (key: string): ObjectStat => ({
    key,
    size: utf8.encode(held.get(key) ?? "").byteLength,
    lastModified: new Date(),
    contentType,
    userMetadata: {},
  });

  return {
    ...stubStorage({
      capabilities: ["presignedUrls"],
      put: async (key, body) => {
        held.set(key, typeof body === "string" ? body : "");

        return describe(key);
      },
      stat: async (key) => describe(key),
      exists: async (key) => held.has(key),
    }),
    ...fields,
  };
};

const refuseLifetime = async (): Promise<never> => {
  throw new StorageError({
    code: "InvalidOption",
    message: "`expiresIn` takes a whole number of seconds from 1 to 604800",
    operation: "presignGet",
    bucket: "stub",
    provider: "stub",
    attempts: 0,
  });
};

const run = async (name: string, storage: Storage): Promise<string> => {
  const context = await startRun(stubTarget({ createStorage: () => storage }), createKeyPrefix());
  const half = selectHalf(caseNamed(name), context);

  await half.run();

  return half.mode;
};

test("`presign/get` reads the answer of the URL a storage handed out", async () => {
  // A `data:` URL is one `fetch` answers without a provider, which is as far as a test of
  // this package goes: the signature itself belongs to `adapter-s3`.
  const storage = signing({
    presignGet: async () =>
      `data:${contentType};base64,${btoa("the body a signed `GET` hands out")}`,
  });

  await expect(run("presign/get", storage)).resolves.toBe("declared");
});

test("the `presign/get` case refuses a URL answering another body than the object holds", async () => {
  const storage = signing({
    presignGet: async () => `data:${contentType};base64,${btoa("another body")}`,
  });

  await expect(run("presign/get", storage)).rejects.toThrow(
    "the body a signed `GET` answered with",
  );
});

test("`presign/expires-in-bounds` reads both methods for the lifetimes spec 7.10 refuses", async () => {
  const storage = signing({ presignGet: refuseLifetime, presignPut: refuseLifetime });

  await expect(run("presign/expires-in-bounds", storage)).resolves.toBe("declared");
});

test("the `presign/expires-in-bounds` case refuses a storage signing a lifetime outside them", async () => {
  const storage = signing({
    presignGet: refuseLifetime,
    presignPut: async () => "https://example.invalid/signed",
  });

  await expect(run("presign/expires-in-bounds", storage)).rejects.toThrow(
    "`presignPut` with an `expiresIn` of 0, and the call resolved",
  );
});

/**
 * A storage handing back the URL with `content-type` and the header of another provider,
 * and `land`, which writes an upload under the key it signed for.
 */
function signingWithBlobType(): { storage: Storage; land: (body: string) => Promise<void> } {
  let signedKey = "";
  const storage = signing({
    presignPut: async (key) => {
      signedKey = key;

      return { url: signedUrl, headers: { "content-type": contentType, ...blobType } };
    },
  });

  return {
    storage,
    land: async (body) => {
      await storage.put(signedKey, body);
    },
  };
}

/** The provider the URL points at: it answers `status` to each upload and records it. */
function providerAnswering(status: number, land?: (body: string) => Promise<void>): Request[] {
  const uploads: Request[] = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const request = new Request(url, init);

    uploads.push(request);
    await land?.(await request.clone().text());

    return new Response(null, { status });
  });

  return uploads;
}

test.each(["presign/put", "flow/2-presigned-put"])(
  "`%s` uploads with the headers the storage handed back",
  async (name) => {
    const { storage, land } = signingWithBlobType();
    const uploads = providerAnswering(200, land);

    await expect(run(name, storage)).resolves.toBe("declared");
    expect(uploads.map((upload) => upload.method)).toEqual(["PUT"]);
    expect(Object.fromEntries(uploads[0]!.headers)).toMatchObject({
      "content-type": contentType,
      ...blobType,
    });
  },
);

test.each([
  ["presign/put-rejects-type", 403, "application/json"],
  ["presign/put-rejects-length", 400, contentType],
])("`%s` keeps the headers the storage handed back", async (name, status, sentType) => {
  const { storage } = signingWithBlobType();
  const uploads = providerAnswering(status);

  await expect(run(name, storage)).resolves.toBe("declared");
  expect(Object.fromEntries(uploads[0]!.headers)).toMatchObject({
    "content-type": sentType,
    ...blobType,
  });
});

test.each([
  ["a bare URL", signedUrl],
  ["no headers", { url: signedUrl }],
  ["headers as an array", { url: signedUrl, headers: ["content-type", contentType] }],
  [
    "headers as `Headers`",
    { url: signedUrl, headers: new Headers({ "content-type": contentType }) },
  ],
  [
    "`Content-Length` among the headers",
    { url: signedUrl, headers: { "content-type": contentType, "Content-Length": "29" } },
  ],
])("the `presign/put` case refuses a storage handing back %s", async (_, presigned) => {
  const uploads = providerAnswering(200);
  const storage = signing({ presignPut: async () => presigned });

  await expect(run("presign/put", storage)).rejects.toThrow("`presignPut` handed back");
  expect(uploads).toEqual([]);
});

/** A storage signing a URL that names the lifetime it was signed for. */
function signingLifetimes(): Storage {
  return signing({
    presignGet: async (_, { expiresIn }) => `${signedUrl}?expires-in=${expiresIn}`,
  });
}

/**
 * The provider those URLs point at: it answers `expired` to the URL signed for
 * `expiredLifetime` and `control` to the one for `controlLifetime`, and records the lifetime
 * of each URL fetched.
 */
function providerAnsweringLifetimes(answers: { expired: number; control: number }): number[] {
  const fetchedLifetimes: number[] = [];

  vi.stubGlobal("fetch", async (url: string) => {
    const expiresIn = Number(new URL(url).searchParams.get("expires-in"));

    fetchedLifetimes.push(expiresIn);

    return new Response(null, {
      status: expiresIn === expiredLifetime ? answers.expired : answers.control,
    });
  });

  return fetchedLifetimes;
}

/** The case waits `pastTheLifetime` out, which fake timers pass at once. */
async function runExpiredUrl(storage: Storage): Promise<string> {
  vi.useFakeTimers();

  try {
    const outcome = run("presign/expired-url", storage);

    // Held so that a rejection arriving while the timers advance is not reported unhandled.
    outcome.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(pastTheLifetime);

    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}

test.each([400, 403])(
  "`presign/expired-url` takes %i for the expired URL and `200` for the control",
  async (status) => {
    const fetchedLifetimes = providerAnsweringLifetimes({ expired: status, control: 200 });

    await expect(runExpiredUrl(signingLifetimes())).resolves.toBe("declared");
    expect(fetchedLifetimes.toSorted((a, b) => a - b)).toEqual([expiredLifetime, controlLifetime]);
  },
);

test.each([200, 401, 404])(
  "the `presign/expired-url` case refuses %i for the expired URL",
  async (status) => {
    providerAnsweringLifetimes({ expired: status, control: 200 });

    await expect(runExpiredUrl(signingLifetimes())).rejects.toThrow(
      `a signed \`GET\` that has expired was answered ${status} and not 400 or 403`,
    );
  },
);

test("the `presign/expired-url` case refuses a control URL answering other than `200`", async () => {
  providerAnsweringLifetimes({ expired: 400, control: 400 });

  await expect(runExpiredUrl(signingLifetimes())).rejects.toThrow(
    `the signed \`GET\` for ${controlLifetime} seconds beside it was answered 400 and not 200`,
  );
});

const blobHeaderNames = {
  cacheControl: "x-ms-blob-cache-control",
  contentDisposition: "x-ms-blob-content-disposition",
  contentLanguage: "x-ms-blob-content-language",
} as const satisfies Record<keyof ContentHeaders, string>;

const contentHeaderOptions: readonly (keyof ContentHeaders)[] = [
  "cacheControl",
  "contentDisposition",
  "contentLanguage",
];

/** How the stub provider answers an upload, from what was signed and what the upload sent. */
type ProviderCheck = (signed: Headers, sent: Headers) => number;

/** A provider binding what was signed, as spec 7.10, 8.9 and 9.9 have every provider do. */
const binding: ProviderCheck = (signed, sent) =>
  [...signed].every(([name, value]) => sent.get(name) === value) ? 201 : 403;

/**
 * A storage declaring `presignedUrls` and `contentHeaders` that hands each content header
 * back under its `x-ms-blob-*` name, as `adapter-azure-blob` does, so that the suite is seen
 * to name no provider's headers; and the provider its URL points at, which stores what an
 * upload sends under those names and answers as `check` decides.
 */
function signingContentHeaders(
  check: ProviderCheck = binding,
  report: (held: ContentHeaders) => ContentHeaders = (held) => held,
): { storage: Storage; uploads: Request[] } {
  const stored = new Map<string, ContentHeaders>();
  const uploads: Request[] = [];
  let signedKey = "";
  let signed = new Headers();

  const storage = {
    ...stubStorage({
      capabilities: ["presignedUrls", "contentHeaders"],
      stat: async (key) => ({
        key,
        size: 0,
        lastModified: new Date(),
        contentType,
        userMetadata: {},
        ...report(stored.get(key) ?? {}),
      }),
      exists: async (key) => stored.has(key),
    }),
    presignPut: async (key: string, options: ContentHeaders) => {
      signedKey = key;
      signed = new Headers({ "content-type": contentType });

      for (const option of contentHeaderOptions) {
        const value = options[option];

        if (value !== undefined) signed.set(blobHeaderNames[option], value);
      }

      return { url: signedUrl, headers: Object.fromEntries(signed) };
    },
  };

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    const status = check(signed, request.headers);

    uploads.push(request);

    if (status < 300) {
      const held: Record<string, string> = {};

      for (const option of contentHeaderOptions) {
        const value = request.headers.get(blobHeaderNames[option]);

        if (value !== null) held[option] = value;
      }

      stored.set(signedKey, held);
    }

    return new Response(null, { status });
  });

  return { storage, uploads };
}

test("`presign/put-content-headers` uploads with the content headers the storage handed back", async () => {
  const { storage, uploads } = signingContentHeaders();

  await expect(run("presign/put-content-headers", storage)).resolves.toBe("declared");
  expect(uploads).toHaveLength(1);
  expect([...uploads[0]!.headers.keys()]).toEqual(
    expect.arrayContaining(Object.values(blobHeaderNames)),
  );
});

test("the `presign/put-content-headers` case refuses a `stat` reporting another value", async () => {
  const { storage } = signingContentHeaders(binding, (held) => ({
    ...held,
    contentLanguage: held.contentLanguage?.replaceAll(" ", ""),
  }));

  await expect(run("presign/put-content-headers", storage)).rejects.toThrow(
    "`stat` reports `contentLanguage`",
  );
});

test("the `presign/put-content-headers` case refuses a `stat` reporting a `contentEncoding`", async () => {
  const { storage } = signingContentHeaders(binding, (held) => ({
    ...held,
    contentEncoding: "gzip",
  }));

  await expect(run("presign/put-content-headers", storage)).rejects.toThrow("`contentEncoding`");
});

test("`presign/put-rejects-content-headers` sends each content header once differing and once left out", async () => {
  const { storage, uploads } = signingContentHeaders();

  await expect(run("presign/put-rejects-content-headers", storage)).resolves.toBe("declared");
  expect(uploads).toHaveLength(6);

  for (const name of Object.values(blobHeaderNames)) {
    const carrying = uploads.filter((upload) => upload.headers.has(name));

    expect(uploads.length - carrying.length).toBe(1);
  }
});

const cacheControlName = blobHeaderNames.cacheControl;

/** A provider that binds every signed header but `Cache-Control`, whose value it never reads. */
const admittingAnyCacheControl: ProviderCheck = (signed, sent) => {
  const compared = new Headers(signed);

  if (sent.has(cacheControlName)) compared.set(cacheControlName, sent.get(cacheControlName)!);

  return binding(compared, sent);
};

/** A provider that binds every signed header, and reads a missing `Cache-Control` as none. */
const admittingNoCacheControl: ProviderCheck = (signed, sent) => {
  const compared = new Headers(signed);

  if (!sent.has(cacheControlName)) compared.delete(cacheControlName);

  return binding(compared, sent);
};

test.each([
  ["a differing value", admittingAnyCacheControl, "another `cacheControl`"],
  ["a value left out", admittingNoCacheControl, "no `cacheControl`"],
])(
  "the `presign/put-rejects-content-headers` case refuses a provider admitting %s",
  async (_, check, what) => {
    const { storage } = signingContentHeaders(check);

    await expect(run("presign/put-rejects-content-headers", storage)).rejects.toThrow(
      `A signed \`PUT\` carrying ${what} was answered 201 and not refused`,
    );
  },
);

/** A storage declaring `presignedUrls` alone, which refuses the three as spec 4.3 has it. */
function signingWithoutContentHeaders(): Storage {
  return signing({
    presignPut: async (_, options) => {
      if (contentHeaderOptions.some((option) => Reflect.get(options, option) !== undefined)) {
        throw new StorageError({
          code: "Unsupported",
          message: "This storage holds no content headers",
          operation: "presignPut",
          bucket: "stub",
          provider: "stub",
          capability: "contentHeaders",
          attempts: 0,
        });
      }

      return { url: signedUrl, headers: { "content-type": contentType } };
    },
  });
}

test.each(["presign/put-content-headers", "presign/put-rejects-content-headers"])(
  "`%s` holds where the storage declares `presignedUrls` and no `contentHeaders`",
  async (name) => {
    await expect(run(name, signingWithoutContentHeaders())).resolves.toBe("without");
  },
);

test("the half without `contentHeaders` refuses a storage signing one of the three", async () => {
  const storage = signing({
    presignPut: async () => ({ url: signedUrl, headers: { "content-type": contentType } }),
  });

  await expect(run("presign/put-content-headers", storage)).rejects.toThrow(
    '`code: "Unsupported"`',
  );
});

test("the half without `contentHeaders` refuses a storage refusing a `presignPut` without them", async () => {
  const storage = signing({
    presignPut: async () => {
      throw new StorageError({
        code: "Unsupported",
        message: "This storage holds no content headers",
        operation: "presignPut",
        bucket: "stub",
        provider: "stub",
        capability: "contentHeaders",
        attempts: 0,
      });
    },
  });

  await expect(run("presign/put-content-headers", storage)).rejects.toThrow(
    "This storage holds no content headers",
  );
});

interface PreconditionProvider {
  /** Reads the precondition of an upload that carries no binding header as none at all. */
  readonly admitsUnbound?: boolean;
  /** Writes whatever the precondition says, as fake-gcs-server does with a signed `PUT`. */
  readonly ignoresPreconditions?: boolean;
}

/**
 * A storage declaring `presignedUrls` and both write capabilities that binds a precondition as
 * `adapter-s3` does, through `if-none-match` and `if-match`; and the provider its URLs point
 * at, which refuses a request missing a signed header and checks the precondition it carries.
 */
function signingPreconditions(provider: PreconditionProvider = {}): {
  storage: Storage;
  uploads: Request[];
} {
  const held = new Map<string, { readonly bytes: Uint8Array; readonly etag: string }>();
  const signedHeaders = new Map<string, Headers>();
  const uploads: Request[] = [];
  let written = 0;

  const store = (key: string, bytes: Uint8Array): void => {
    written += 1;
    held.set(key, { bytes, etag: `etag-${written}` });
  };
  const describe = (key: string): ObjectStat => ({
    key,
    size: held.get(key)?.bytes.byteLength ?? 0,
    lastModified: new Date(),
    contentType,
    userMetadata: {},
    etag: held.get(key)?.etag,
  });

  const storage = {
    ...stubStorage({
      capabilities: ["presignedUrls", "writeIfAbsent", "writeIfUnchanged"],
      put: async (key, body) => {
        if (!(body instanceof Uint8Array)) throw new Error("The cases hand `put` bytes");

        store(key, body);

        return describe(key);
      },
      get: async (key): Promise<StoredObject> => {
        const bytes = held.get(key)?.bytes ?? new Uint8Array();

        return {
          stat: describe(key),
          stream: () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
          bytes: async () => bytes,
          text: async () => new TextDecoder().decode(bytes),
          json: async () => JSON.parse(new TextDecoder().decode(bytes)),
        };
      },
      stat: async (key) => describe(key),
      exists: async (key) => held.has(key),
    }),
    presignPut: async (key: string, options: { onlyIf?: Precondition }) => {
      const headers = new Headers({ "content-type": contentType });

      if (options.onlyIf === "absent") headers.set("if-none-match", "*");
      if (typeof options.onlyIf === "object") headers.set("if-match", `"${options.onlyIf.etag}"`);

      const url = `${signedUrl}?key=${encodeURIComponent(key)}&n=${signedHeaders.size}`;

      signedHeaders.set(url, headers);

      return { url, headers: Object.fromEntries(headers) };
    },
  };

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    const key = new URL(url).searchParams.get("key") ?? "";
    const signed = signedHeaders.get(url) ?? new Headers();
    const sent = request.headers;
    const object = held.get(key);

    uploads.push(request);

    const bound = [...signed].every(
      ([name, value]) =>
        sent.get(name) === value || (provider.admitsUnbound === true && !sent.has(name)),
    );

    if (!bound) return new Response(null, { status: 403 });

    const fails =
      provider.ignoresPreconditions !== true &&
      ((sent.get("if-none-match") === "*" && object !== undefined) ||
        (sent.has("if-match") && sent.get("if-match") !== `"${object?.etag}"`));

    if (fails) return new Response(null, { status: 412 });

    store(key, new Uint8Array(await request.arrayBuffer()));

    return new Response(null, { status: 200 });
  });

  return { storage, uploads };
}

test.each([
  "presign/put-if-absent",
  "presign/put-if-unchanged",
  "presign/put-rejects-precondition",
])("`%s` holds against a provider that binds and checks the precondition", async (name) => {
  const { storage } = signingPreconditions();

  await expect(run(name, storage)).resolves.toBe("declared");
});

test.each([
  ["presign/put-if-absent", 'bound to `"absent"` onto a key that holds an object'],
  ["presign/put-if-unchanged", "bound to an `etag` another `put` replaced"],
])("the `%s` case refuses a provider writing past the precondition", async (name, what) => {
  const { storage } = signingPreconditions({ ignoresPreconditions: true });

  await expect(run(name, storage)).rejects.toThrow(`A signed \`PUT\` ${what} was answered 200`);
});

test("`presign/put-rejects-precondition` sends each binding header once differing and once left out", async () => {
  const { storage, uploads } = signingPreconditions();

  await expect(run("presign/put-rejects-precondition", storage)).resolves.toBe("declared");
  expect(uploads.map((upload) => upload.headers.get("if-none-match"))).toEqual([
    null,
    '"conformance"',
    null,
    null,
  ]);
  expect(uploads.map((upload) => upload.headers.get("if-match"))).toEqual([
    null,
    null,
    null,
    expect.stringMatching(/^"etag-\d+"0$/u),
  ]);
});

test("the `presign/put-rejects-precondition` case refuses a provider admitting a binding left out", async () => {
  const { storage } = signingPreconditions({ admitsUnbound: true });

  await expect(run("presign/put-rejects-precondition", storage)).rejects.toThrow(
    "carrying no `if-none-match` was answered 200",
  );
});

/** A storage declaring `presignedUrls` and the capabilities given, refusing any other `onlyIf`. */
function signingWithout(capabilities: readonly ("writeIfAbsent" | "writeIfUnchanged")[]): Storage {
  return {
    ...signing({}),
    capabilities: ["presignedUrls", ...capabilities],
    presignPut: async (key: string, options: { onlyIf?: unknown }) => {
      const refusal = preconditionRefusal(options.onlyIf, "write", capabilities);

      if (refusal !== undefined) {
        throw new StorageError({
          ...refusal,
          operation: "presignPut",
          key,
          bucket: "stub",
          provider: "stub",
          attempts: 0,
        });
      }

      return { url: signedUrl, headers: { "content-type": contentType } };
    },
  } as Storage;
}

test.each([
  "presign/put-if-absent",
  "presign/put-if-unchanged",
  "presign/put-rejects-precondition",
])(
  "`%s` holds where the storage declares `presignedUrls` and neither write capability",
  async (name) => {
    await expect(run(name, signingWithout([]))).resolves.toBe("without");
  },
);

test("the `presign/put-rejects-precondition` half refuses only the kind the storage declares nothing for", async () => {
  await expect(
    run("presign/put-rejects-precondition", signingWithout(["writeIfAbsent"])),
  ).resolves.toBe("without");
});

test("the half without `writeIfAbsent` refuses a storage signing a URL bound to it", async () => {
  const storage = signing({
    presignPut: async () => ({ url: signedUrl, headers: { "content-type": contentType } }),
  });

  await expect(run("presign/put-if-absent", storage)).rejects.toThrow('`code: "Unsupported"`');
});
