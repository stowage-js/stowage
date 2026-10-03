import { redirectToObject } from "@stowage/http";

import { keyOf, storage } from "../../../lib/storage.js";

export async function GET(request, context) {
  return await redirectToObject(storage(), await keyOf(context), request, { expiresIn: 60 });
}

export { GET as POST, GET as PUT, GET as DELETE };
