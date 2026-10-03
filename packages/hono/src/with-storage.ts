import type { Storage } from "@stowage/core";
import type { Context, Env, MiddlewareHandler } from "hono";

/**
 * A middleware that sets `storage` on `c.var[name]` for the routes it runs on, keeping its
 * concrete type. Two storages are two calls.
 *
 * @param storage A constructed storage, set as it is, or a function called on every request
 *   and never cached, which builds the storage from the request's context. On `workerd`,
 *   where a credential arrives in `c.env`, that is the form to use; its `Bindings` are read
 *   from its annotated parameter, `(c: Context<{ Bindings: Env }>) => …`. It may return a
 *   `Promise`, for a binding that hands over its value only asynchronously.
 */
export function withStorage<K extends string, S extends Storage, E extends Env = Env>(
  name: K,
  storage: S | ((c: Context<E>) => S | Promise<S>),
): MiddlewareHandler<{ Variables: { [k in K]: S } }> {
  return async (c, next) => {
    // Spec 12 types the middleware by the variables it sets alone, so the `Bindings` the
    // factory's parameter names are the caller's word for the application it runs in.
    // oxlint-disable-next-line no-unsafe-type-assertion -- as said above
    const context = c as unknown as Context<E>;

    c.set(name, typeof storage === "function" ? await storage(context) : storage);
    await next();
  };
}
