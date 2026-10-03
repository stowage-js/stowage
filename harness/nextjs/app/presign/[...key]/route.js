import { presignUpload } from "@stowage/http";

import { keyOf, storage } from "../../../lib/storage.js";

/**
 * Spec 14.8's `presign` route, which is the application's and not a protocol of the layer:
 * both values of the JSON body go on as they arrived, so that the layer's own checks of
 * spec 10.6 are what a case meets.
 */
export async function POST(request, context) {
  let values;

  try {
    values = JSON.parse(await request.text());
  } catch {
    return new Response(null, { status: 400 });
  }

  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return new Response(null, { status: 400 });
  }

  const { contentType, contentLength } = values;

  return await presignUpload(storage(), await keyOf(context), {
    expiresIn: 60,
    maxSize: 1048576,
    contentType,
    contentLength,
  });
}

// `presignUpload` takes no request and cannot see the method, so the route answers the
// others itself (spec 14.8).
function notAllowed() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export { notAllowed as GET, notAllowed as PUT, notAllowed as DELETE };
