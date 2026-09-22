/** What a resolver is told when the adapter asks for a credential again (spec 4.12). */
export type ResolverOptions = { forceRefresh: boolean };

/** A value, or a function that yields one. No core signature mentions it (ADR 0007). */
export type Resolvable<T> = T | ((options?: ResolverOptions) => T | Promise<T>);
