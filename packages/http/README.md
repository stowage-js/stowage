# @stowage/http

The HTTP layer of stowage: it answers a web `Request` on a storage's behalf for a key the caller
has already named, and resolves with a web `Response`. A server that cannot send a web `Response`
reaches it through the Node bridge.
