import { acceptUpload } from "@stowage/http";

import { keyOf, maxSize, storage } from "../../../lib/storage.js";

export async function PUT(request, context) {
  return await acceptUpload(storage(), await keyOf(context), request, { maxSize });
}

export { PUT as GET, PUT as POST, PUT as DELETE };
