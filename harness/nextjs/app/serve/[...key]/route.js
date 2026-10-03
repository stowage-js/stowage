import { serveObject } from "@stowage/http";

import { keyOf, storage } from "../../../lib/storage.js";

// Spec 10.3: Next.js answers `HEAD` through this handler, with the request's method kept.
export async function GET(request, context) {
  return await serveObject(storage(), await keyOf(context), request);
}

export { GET as POST, GET as PUT, GET as DELETE };
