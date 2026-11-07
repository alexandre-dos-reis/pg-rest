import type { RequestContext } from "@tsql/core/core";
import { type EngineOptions, createEngine } from "@tsql/core/engine";
import {
  type ContextQuery,
  type ContextSource,
  type QueryInput,
  type QueryResult,
  type Transaction,
  type TransactionOptions,
  failedTransaction,
  noContextResult,
  noContextTransaction,
  resolveContextSource,
  runQuery,
  runTransaction,
  toFailedResult,
} from "./query";
import type { SchemaCache } from "@tsql/core/schema";
import type { GenerateTypesOptions } from "./types";
import type { AnyDatabase, TypedQueryInstance } from "./typed";

export type { DbAdapter, DbSession, Row } from "@tsql/core/adapter";
export type { PreRequestInfo, RequestContext } from "@tsql/core/core";
export { ApiError, DbQueryError, PgRestError, describeErrorKind, errorKind } from "@tsql/core/errors";
export type { ErrorBody, QueryErrorKind } from "@tsql/core/errors";
export { QueryError } from "./query";
export type {
  AnyDatabase,
  AnyRelation,
  AnySchema,
  AnySignature,
  QueryData,
  TypedContextQuery,
  TypedTransaction,
  TypedQueryInstance,
  TypedQuery,
} from "./typed";
export type {
  CompositeValue,
  ContextQuery,
  ContextSource,
  CountFrom,
  CountOf,
  DeleteQuery,
  Embed,
  DefaultValue,
  Expression,
  Filter,
  FilterOp,
  FilterValue,
  FtsOp,
  FtsValue,
  InsertQuery,
  IsolationLevel,
  OperatorModifiers,
  OperatorSpec,
  OperatorValue,
  Order,
  QueryFailed,
  QueryInput,
  QueryOk,
  QueryResult,
  QueryReturning,
  RpcQuery,
  SetInput,
  Scalar,
  Select,
  SelectQuery,
  Transaction,
  TransactionOptions,
  TransactionRetry,
  UpdateQuery,
  Where,
} from "./query";
export type {
  Column,
  CompositeAttribute,
  CompositeRef,
  CompositeType,
  ForeignKey,
  FunctionDef,
  Relation,
  SchemaCache,
} from "@tsql/core/schema";
export { SchemaLoadError } from "@tsql/core/service";
export type { GenerateTypesOptions } from "./types";

/**
 * What `createQuery` takes: the database and the settings a query reads. There is nothing about HTTP
 * here -- that is `@tsql/rest`.
 */
export interface QueryOptions extends EngineOptions {}

export interface QueryInstance {
  /**
   * Run a query described by an object, in-process: no `Request`, no URL, no HTTP status.
   * It goes through the same parser, the same SQL and the same error mapping as `handle()` of
   * `@tsql/rest`, so the database sees the same thing either way.
   *
   * Only the HTTP envelope is gone, which is also what it cannot do: content negotiation
   * (CSV, GeoJSON, custom media types), `EXPLAIN` plans and OpenAPI stay on `@tsql/rest`.
   *
   * A failure is part of the result, not an exception: `const { data, error } = await
   * pgRest.query({ table: "todos" })`. Exactly one of the two is set, so `if (error)` leaves
   * `data` non-null, and `error` is a {@link QueryError} carrying the PostgREST status, body
   * (`code`, `message`, `details`, `hint`) and the input that produced it.
   *
   * It never rejects: an error the library did not foresee comes back as a 500 `error` carrying the
   * original under `cause`, so checking `error` is enough and no `try`/`catch` is needed.
   */
  query<T = unknown>(input: QueryInput, ctx?: RequestContext): Promise<QueryResult<T>>;
  /**
   * {@link QueryInstance.query} with the context decided once: `source` is either a fixed
   * {@link RequestContext} or a function called at every call, so an `AsyncLocalStorage` entered by
   * your middleware answers "who is asking" without threading `ctx` through every layer.
   *
   * ```ts ignore
   * const store = new AsyncLocalStorage<RequestContext>();
   * const db = pgRest.setContextQuery(() => store.getStore());
   * // in a middleware: store.run({ role: "authenticated", claims: { sub: userId } }, next)
   * const { data, error } = await db({ table: "todos" });
   * ```
   *
   * pg-rest holds no store of its own -- that keeps it dependency-free and runtime-neutral, and
   * lets the context come from anywhere, not just `node:async_hooks`.
   *
   * A context passed to the call wins over `source`, which is how an administrative query steps
   * out of the ambient context without leaving its scope. A `source` that returns nothing (the
   * store was never entered) is a 500 `PGRSTX01` `error`, not a silent fall back to the anonymous
   * role. Like `query`, it never rejects.
   */
  setContextQuery(source: ContextSource): ContextQuery;
  /**
   * Run several queries in **one** transaction: the context applied once for all of it, a commit
   * when the callback returns, a rollback when it throws -- two writes that must land together, in
   * the library rather than beside it.
   *
   * ```ts ignore
   * const { data, error } = await pgRest.transaction(async (tx) => {
   *   const order = await tx.query({ table: "orders", action: "insert", rows: { client_id: 1 }, single: true });
   *   await tx.query({ table: "order_items", action: "insert", rows: itemsFor(order.data.id) });
   *   return order.data;
   * }, { role: "authenticated", claims: { sub: user.id } });
   * ```
   *
   * `tx.query` differs from {@link QueryInstance.query} in two ways, both of them consequences of
   * sharing a transaction. It takes **no context**: the role and the claims are transaction-local
   * and issued once at the head of the transaction, so a per-call context would change the role for
   * every statement that follows instead of scoping anything. And it **rejects** on failure instead
   * of answering an `error`, because a query that failed is a transaction that will not commit --
   * which makes its result the success, with `data` and `count` needing no narrowing.
   *
   * The scope is where the promise that does not reject lives: this answers a {@link QueryResult}
   * around whatever the callback returned -- `data` is that value, there is no `count` -- and the
   * failure that left it is its `error`. `tx.transaction()`, a savepoint, is how a query is allowed
   * to fail without taking the rest of the transaction with it.
   */
  transaction<A>(fn: (tx: Transaction) => Promise<A>, options?: TransactionOptions): Promise<QueryResult<A, undefined>>;
  /** Re-read the database catalog (after migrations). */
  reloadSchema(): Promise<void>;
  /** The current introspected schema. */
  schemaCache(): Promise<SchemaCache>;
  /**
   * TypeScript types for this database, as the text of a module. Write it next to your code, keep
   * it in version control, and hand the type it exports to `createQuery<Database>` so queries
   * check themselves. Run it again after a migration.
   *
   * ```ts
   * writeFileSync("src/db.types.ts", await pgRest.generateTypes({ name: "Database" }));
   * ```
   *
   * The generator is loaded on demand, so a server that never calls this never pays for it. The
   * same function is exported standalone as `@tsql/query/types` for when you hold a
   * {@link SchemaCache} rather than an instance.
   */
  generateTypes(options?: GenerateTypesOptions): Promise<string>;
  /** Stop the instance. The database adapter is left open: close it yourself. */
  close(): Promise<void>;
}

export interface CreateQuery {
  (options: QueryOptions): Promise<QueryInstance>;
  /**
   * With a database type from `generateTypes` (`@tsql/query/types`), `query` is typed by it: `table` and `rpc` are the ones that exist, `select`, `where` and `order` only
   * name real columns and relationships, and `data` is inferred from the `select`.
   */
  <Db extends AnyDatabase>(options: QueryOptions): Promise<TypedQueryInstance<Db>>;
}

const create = async (options: QueryOptions): Promise<QueryInstance> => {
  const { adapter, config, store } = await createEngine(options);

  const query = async <T = unknown>(input: QueryInput, ctx?: RequestContext): Promise<QueryResult<T>> => {
    try {
      return (await runQuery({ db: adapter, config, cache: store.current() }, input, ctx ?? {})) as QueryResult<T>;
    } catch (e) {
      // runQuery does not throw; this covers everything around it, so the promise cannot reject
      return toFailedResult(input, e) as QueryResult<T>;
    }
  };

  const transaction = async <A>(
    fn: (tx: Transaction) => Promise<A>,
    scope?: TransactionOptions,
  ): Promise<QueryResult<A, undefined>> => {
    try {
      return await runTransaction<A>({ db: adapter, config, cache: store.current() }, fn, scope);
    } catch (e) {
      // runTransaction does not throw; this covers everything around it, so the promise cannot reject
      return failedTransaction(e) as QueryResult<A, undefined>;
    }
  };

  const setContextQuery = (source: ContextSource): ContextQuery => {
    // The source is read per call, not once here: that is what makes an AsyncLocalStorage useful,
    // one bound `db` serving a different context for every request in flight.
    const call = async <T = unknown>(input: QueryInput, ctx?: RequestContext): Promise<QueryResult<T>> => {
      let context = ctx;
      if (!context) {
        try {
          context = await resolveContextSource(source);
        } catch (e) {
          return toFailedResult(input, e) as QueryResult<T>;
        }
        if (!context) return noContextResult(input) as QueryResult<T>;
      }
      return query<T>(input, context);
    };

    // A scope reads the source **once**, on entry: the transaction has one `set_config`, so a
    // source answering differently halfway through could not be honoured anyway. And it is read
    // before the `BEGIN`, so nothing answering gives back a `PGRSTX01` rather than an open
    // transaction with nothing in it.
    const bound = async <A>(
      fn: (tx: Transaction) => Promise<A>,
      scope?: TransactionOptions,
    ): Promise<QueryResult<A, undefined>> => {
      const overrides = scope?.role !== undefined || scope?.claims !== undefined || scope?.settings !== undefined;
      if (overrides) return transaction<A>(fn, scope);
      let context: RequestContext | undefined;
      try {
        context = await resolveContextSource(source);
      } catch (e) {
        return failedTransaction(e) as QueryResult<A, undefined>;
      }
      if (!context) return noContextTransaction() as QueryResult<A, undefined>;
      return transaction<A>(fn, { ...context, ...(scope ?? {}) });
    };

    return Object.assign(call, { transaction: bound });
  };

  return {
    query,
    setContextQuery,
    transaction,
    // Type generation is a build-time job: importing it here would put the generator in the bundle
    // of every server that only serves requests, so it is fetched when it is actually wanted.
    generateTypes: async (forTypes?: GenerateTypesOptions) =>
      (await import("./types")).generateTypes(store.current(), forTypes),
    reloadSchema: async () => void (await store.reload()),
    schemaCache: async () => store.current(),
    close: async () => {},
  };
};

/**
 * Create the in-process query API over a Postgres database.
 *
 * `createQuery<Db>(options)` returns the same instance with `query` typed by a
 * generated database type; the cast is the whole of that difference, since types never reach
 * runtime and the two instances are one object.
 */
export const createQuery: CreateQuery = create as CreateQuery;
