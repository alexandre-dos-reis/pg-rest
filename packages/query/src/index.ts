import type { RequestContext } from "@tsql/core/core";
import { type EngineOptions, createStaticEngine } from "@tsql/core/engine";
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
import { type SchemaDescriptor, fromDescriptor } from "@tsql/core/schema";
import type { AnyDatabase, TypedQueryInstance } from "./typed";

export type { DbAdapter, DbSession, Row } from "@tsql/core/adapter";
export type { PreRequestInfo, RequestContext } from "@tsql/core/core";
export { describeErrorKind } from "@tsql/core/kinds";
export type { ErrorKind as QueryErrorKind } from "@tsql/core/kinds";
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
export type { SchemaDescriptor } from "@tsql/core/schema";

/**
 * What `createQuery` takes: the database and the settings a query reads. There is nothing about HTTP
 * here -- that is `@tsql/rest`.
 */
export interface QueryOptions extends Omit<EngineOptions, "schemas"> {
  /**
   * The schema of the database, as generated at build time by `@tsql/query/types`. Nothing is read
   * from the catalog when the instance is created or while it runs, and the descriptor is not
   * checked: the types are what keep a query and the schema in step. The first schema it lists is
   * the default one.
   */
  readonly schema: SchemaDescriptor;
}

export interface QueryInstance {
  /**
   * Run a query described by an object, in-process: no `Request`, no URL, no HTTP status.
   *
   * A failure is part of the result, not an exception: `const { data, error } = await
   * pgRest.query({ table: "todos" })`. Exactly one of the two is set, so `if (error)` leaves
   * `data` non-null, and `error` is a {@link QueryError}: a `kind` to switch on, the `message`, `details`
   * and `hint`, the `sqlState` of a database error, and the input that produced it.
   *
   * It never rejects: an error the library did not foresee comes back as an `internal` `error` carrying the
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
   * store was never entered) is a `no_context` `error`, not a silent fall back to the anonymous
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
  /** Stop the instance. The database adapter is left open: close it yourself. */
  close(): Promise<void>;
}

export interface CreateQuery {
  (options: QueryOptions): QueryInstance;
  /**
   * With a database type from `generateTypes` (`@tsql/query/types`), `query` is typed by it: `table` and `rpc` are the ones that exist, `select`, `where` and `order` only
   * name real columns and relationships, and `data` is inferred from the `select`.
   */
  <Db extends AnyDatabase>(options: QueryOptions): TypedQueryInstance<Db>;
}

const create = (options: QueryOptions): QueryInstance => {
  const cache = fromDescriptor(options.schema);
  const { adapter, config } = createStaticEngine({ ...options, schemas: cache.schemas }, cache);

  const query = async <T = unknown>(input: QueryInput, ctx?: RequestContext): Promise<QueryResult<T>> => {
    try {
      return (await runQuery({ db: adapter, config, cache }, input, ctx ?? {})) as QueryResult<T>;
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
      return await runTransaction<A>({ db: adapter, config, cache }, fn, scope);
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
    // before the `BEGIN`, so nothing answering gives back a `no_context` error rather than an open
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
