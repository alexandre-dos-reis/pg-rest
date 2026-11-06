// Who is asking, read from an AsyncLocalStorage your middleware (or your job runner) entered.
//
// This is the whole point of `setContextQuery`: pg-rest holds no store of its own, so the context
// can come from anywhere -- and the application code in transfers.ts never mentions a role, a
// claim or a user id. It just runs queries.
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "@adrdp/pg-rest";
import { pgRest } from "./db.ts";

const store = new AsyncLocalStorage<RequestContext>();

/**
 * The bound query, and the bound scope. `pgQuery(input)` reads the store at every call; the scope
 * reads it **once, on entry**, because a transaction has one `set_config` -- a store answering
 * differently halfway through could not be honoured anyway.
 */
export const pgQuery = pgRest.setContextQuery(() => store.getStore());

/**
 * Enter the store for the extent of a callback. `run`, never `enterWith`: `run` is bounded by its
 * callback, `enterWith` leaks the context into whatever follows in the current async resource.
 */
export const asUser = <T>(sub: string, fn: () => Promise<T>): Promise<T> =>
  store.run({ role: "member", claims: { sub } }, fn);
