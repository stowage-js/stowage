import { expect, test, vi } from "vitest";

import { StorageError } from "./errors.ts";
import { type SendParts, type StreamUploadOptions, uploadStream } from "./upload-stream.ts";

const options: StreamUploadOptions = {
  partSize: 4,
  concurrency: 2,
  maxParts: 100,
  bucket: "stowage",
  provider: "s3",
  key: "object.bin",
};

function streamOf(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
}

function unexpected(): never {
  throw new Error("The upload took the other branch");
}

test("a stream that ends within the first part goes whole", async () => {
  const whole = await uploadStream(streamOf([1, 2], [3]), options, {
    whole: async (bytes) => await Promise.resolve([...bytes]),
    multipart: unexpected,
  });

  expect(whole).toEqual([1, 2, 3]);
});

test("a stream above one part is sent in parts numbered from zero, answered in part order", async () => {
  const sent: [number, number[]][] = [];
  // Settled by the test, which decides the order the parts settle in.
  const answers = [
    Promise.withResolvers<string>(),
    Promise.withResolvers<string>(),
    Promise.withResolvers<string>(),
  ];

  const sending = uploadStream(streamOf([1, 2, 3], [4, 5, 6, 7, 8], [9, 10]), options, {
    whole: unexpected,
    multipart: async (sendParts) =>
      await sendParts(async (index, bytes) => {
        sent.push([index, [...bytes]]);

        return await (answers[index]?.promise ?? Promise.reject(new Error("A fourth part")));
      }),
  });

  await vi.waitFor(() => expect(sent).toHaveLength(2));
  answers[1]?.resolve("second");
  await vi.waitFor(() => expect(sent).toHaveLength(3));
  answers[2]?.resolve("third");
  answers[0]?.resolve("first");

  expect(await sending).toEqual({ results: ["first", "second", "third"], size: 10 });
  expect(sent).toEqual([
    [0, [1, 2, 3, 4]],
    [1, [5, 6, 7, 8]],
    [2, [9, 10]],
  ]);
});

/** A stream of `parts` full parts and a byte more, which records its reads and its cancel. */
function countedStream(parts: number): {
  body: ReadableStream<Uint8Array>;
  pulls: () => number;
  canceled: () => unknown;
} {
  let pulls = 0;
  let canceled: unknown;

  return {
    pulls: () => pulls,
    canceled: () => canceled,
    body: new ReadableStream(
      {
        pull(controller) {
          pulls += 1;

          if (pulls <= parts) controller.enqueue(new Uint8Array(options.partSize));
          else if (pulls === parts + 1) controller.enqueue(new Uint8Array(1));
          else controller.close();
        },
        cancel(reason) {
          canceled = reason ?? "canceled";
        },
      },
      { highWaterMark: 0 },
    ),
  };
}

/** Rejects with the signal's reason once it fired, as a request that honors it does. */
async function abortOf(signal: AbortSignal): Promise<never> {
  return await new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function rejection(act: () => Promise<unknown>): Promise<unknown> {
  try {
    await act();
  } catch (thrown) {
    return thrown;
  }

  throw new Error("The call resolved");
}

test("the first failure of a part stops the rest, cancels the source, and is what rejects", async () => {
  const source = countedStream(10);
  const refused = new Error("The part was refused");
  const signals: AbortSignal[] = [];
  let unsettled = 0;

  const thrown = await rejection(
    async () =>
      await uploadStream(source.body, options, {
        whole: unexpected,
        multipart: async (sendParts) =>
          await sendParts(async (index, _bytes, signal) => {
            signals.push(signal);

            if (index === 1) throw refused;

            unsettled += 1;
            await abortOf(signal).catch(() => {});
            unsettled -= 1;

            throw new Error("A later failure");
          }),
      }),
  );

  expect(thrown).toBe(refused);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(unsettled).toBe(0);
  expect(source.canceled()).toBe(refused);
});

test("the caller's abort fires the parts' signal, cancels the source, and rejects with its reason", async () => {
  const source = countedStream(10);
  const caller = new AbortController();
  const reason = new DOMException("The caller gave up", "AbortError");

  const thrown = await rejection(
    async () =>
      await uploadStream(
        source.body,
        { ...options, signal: caller.signal },
        {
          whole: unexpected,
          multipart: async (sendParts) =>
            await sendParts(async (index, _bytes, signal) => {
              if (index === 1) caller.abort(reason);

              await abortOf(signal);
            }),
        },
      ),
  );

  expect(thrown).toBe(reason);
  expect(source.canceled()).toBe(reason);
});

test("`concurrency` parts go at a time, and the next part is read only once one settled", async () => {
  const source = countedStream(10);
  const answers: (() => void)[] = [];
  let inFlight = 0;
  let mostInFlight = 0;

  const sending = uploadStream(source.body, options, {
    whole: unexpected,
    multipart: async (sendParts) =>
      await sendParts(async (index) => {
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise<void>((resolve) => answers.push(resolve));
        inFlight -= 1;

        return index;
      }),
  });

  await vi.waitFor(() => expect(answers).toHaveLength(2));
  // Two parts in flight, and the chunk that told the second is not the last.
  expect(source.pulls()).toBe(3);

  for (let settledParts = 0; settledParts < 11; settledParts += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each part settles before the next is sent
    await vi.waitFor(() => expect(answers.length).toBeGreaterThan(settledParts));
    answers[settledParts]?.();
  }

  expect((await sending).size).toBe(10 * options.partSize + 1);
  expect(mostInFlight).toBe(2);
});

test("a stream of exactly `maxParts` parts is sent", async () => {
  const source = countedStream(4);
  const sent = await uploadStream(
    source.body,
    { ...options, maxParts: 5 },
    {
      whole: unexpected,
      multipart: async (sendParts) =>
        await sendParts(async (index) => await Promise.resolve(index)),
    },
  );

  expect(sent.results).toEqual([0, 1, 2, 3, 4]);
});

test("a stream above `maxParts` rejects naming `partSize` and the way past it, unsent", async () => {
  const source = countedStream(5);
  const sent: number[] = [];

  const thrown = await rejection(
    async () =>
      await uploadStream(
        source.body,
        { ...options, maxParts: 5 },
        {
          whole: unexpected,
          multipart: async (sendParts) =>
            await sendParts(async (index) => {
              sent.push(index);

              return await Promise.resolve(index);
            }),
        },
      ),
  );

  if (!(thrown instanceof StorageError)) throw thrown;

  expect(thrown).toMatchObject({
    code: "InvalidRequest",
    operation: "put",
    bucket: "stowage",
    provider: "s3",
    key: "object.bin",
    attempts: 0,
  });
  expect(thrown.message).toContain("more than 5 parts");
  expect(thrown.message).toContain("`partSize` of 4 bytes");
  expect(thrown.message).toContain("a larger `multipart.partSize`");
  // The part that would be the fifth is known not to be the last, so it is not sent.
  expect(sent).toEqual([0, 1, 2, 3]);
  expect(source.canceled()).toBe(thrown);
});

test("`maxParts: Infinity` never refuses a stream, past S3's 10,000 parts too", async () => {
  const source = countedStream(10_000);
  const sent = await uploadStream(
    source.body,
    { ...options, maxParts: Infinity },
    {
      whole: unexpected,
      multipart: async (sendParts) =>
        await sendParts(async (index) => await Promise.resolve(index)),
    },
  );

  expect(sent.results).toHaveLength(10_001);
  expect(source.canceled()).toBeUndefined();
});

test("a second call of `sendParts` rejects", async () => {
  const source = countedStream(1);

  const thrown = await rejection(
    async () =>
      await uploadStream(source.body, options, {
        whole: unexpected,
        multipart: async (sendParts) => {
          await sendParts(async () => await Promise.resolve());

          return await sendParts(async () => await Promise.resolve());
        },
      }),
  );

  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(StorageError);
});

test("a start of the upload that fails cancels the source and rejects with its failure", async () => {
  const source = countedStream(10);
  const refused = new Error("The upload could not start");

  const thrown = await rejection(
    async () =>
      await uploadStream(source.body, options, {
        whole: unexpected,
        multipart: async () => await Promise.reject(refused),
      }),
  );

  expect(thrown).toBe(refused);
  expect(source.canceled()).toBe(refused);
});

test("a `multipart` that returns without sending cancels the source", async () => {
  const source = countedStream(10);

  expect(
    await uploadStream(source.body, options, {
      whole: unexpected,
      multipart: async () => await Promise.resolve("nothing sent"),
    }),
  ).toBe("nothing sent");
  expect(source.canceled()).toBeInstanceOf(Error);
});

test("a `sendParts` that `multipart` does not wait for sends nothing after the upload settled", async () => {
  const source = countedStream(10);
  const sent: number[] = [];
  let sending: Promise<unknown> = Promise.resolve();

  await uploadStream(source.body, options, {
    whole: unexpected,
    multipart: async (sendParts) => {
      sending = sendParts(async (index) => {
        sent.push(index);

        return await Promise.resolve(index);
      });

      return await Promise.resolve();
    },
  });

  const sentWhenSettled = sent.length;

  expect(await rejection(async () => await sending)).toBeInstanceOf(Error);
  expect(sent).toHaveLength(sentWhenSettled);
});

test("a stream that ended is not canceled", async () => {
  const source = countedStream(3);

  await uploadStream(source.body, options, {
    whole: unexpected,
    multipart: async (sendParts) => await sendParts(async () => await Promise.resolve()),
  });

  expect(source.canceled()).toBeUndefined();
});

test("a `sendParts` called after the upload settled sends nothing and rejects", async () => {
  const source = countedStream(10);
  const sent: number[] = [];
  let keptSendParts: SendParts | undefined;

  await uploadStream(source.body, options, {
    whole: unexpected,
    multipart: async (sendParts) => {
      keptSendParts = sendParts;

      return await Promise.resolve();
    },
  });

  const late = keptSendParts?.(async (index) => {
    sent.push(index);

    return await Promise.resolve(index);
  });

  expect(await rejection(async () => await late)).toBeInstanceOf(Error);
  expect(sent).toEqual([]);
});

test("the parts still in flight after a failure are stopped with an `AbortError`", async () => {
  const source = countedStream(10);
  const reasons: unknown[] = [];

  await rejection(
    async () =>
      await uploadStream(source.body, options, {
        whole: unexpected,
        multipart: async (sendParts) =>
          await sendParts(async (index, _bytes, signal) => {
            if (index === 1) throw new Error("The part was refused");

            await abortOf(signal).catch((reason: unknown) => reasons.push(reason));
          }),
      }),
  );

  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toBeInstanceOf(DOMException);
  expect(reasons[0]).toMatchObject({ name: "AbortError" });
});
