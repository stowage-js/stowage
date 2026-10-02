import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { serveObject } from "../../../packages/http/src/index.ts";
import { nodeBridgeTarget, type ServedTarget } from "./http.ts";

vi.mock("../../../packages/http/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/http/src/index.ts")>()),
  serveObject: vi.fn<typeof serveObject>(async () => new Response("served")),
}));

let served: ServedTarget;

beforeAll(async () => {
  served = await nodeBridgeTarget({
    bucket: "stowage",
    region: "eu-central-1",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
  });
});

afterAll(async () => await served.close());
beforeEach(() => vi.clearAllMocks());

test.each(["%", "%2", "%GG", "%C3%28", "%FF", "%ED%A0%80"])(
  "a malformed key %s answers 404 without serving an object",
  async (encodedKey) => {
    const url = new URL(`/serve/${encodedKey}`, served.target.url("serve", ""));
    const response = await fetch(url);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(serveObject).not.toHaveBeenCalled();
  },
);

test.each(["report.txt", "docs/report?100%.txt", "café 😀.txt", "%2F"])(
  "a valid key %s is decoded once and passed to serveObject",
  async (key) => {
    const url = served.target.url("serve", key);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("served");
    expect(serveObject).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      key,
      expect.objectContaining({ method: "GET", url: url.href }),
    );
  },
);
