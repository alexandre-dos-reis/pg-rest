import type { SqlRequestContext as RequestContext } from "@tspg/core/core";
import { type EngineOptions, type LazyEngine, createLazyEngine, createStaticEngine } from "@tspg/core/engine";
import {
  type ContextQuery,
  type ContextSource,
  type Operations,
  type PreRequest,
  type QueryConfig,
  type QueryInput,
  type QueryResult,
  type SelectInput,
  type Prepared,
  type PreparedArgs,
  type Transaction,
  type TransactionOptions,
  failedTransaction,
  noContextResult,
  noContextTransaction,
  operationsOf,
  prepareQuery,
  resolveContextSource,
  runQuery,
  runTransaction,
  toFailedResult,
} from "./query";
import { type SchemaCache, type SchemaDescriptor, fromDescriptor } from "@tspg/core/schema";
import type { AnyDatabase, TypedQueryInstance } from "./typed";

export type { DbAdapter, DbSession, Row } from "@tspg/adapters";
export type { SqlRequestContext as RequestContext } from "@tspg/core/core";
export type { PreRequest, PreRequestInfo } from "./query";
export { describeErrorKind } from "./kinds";
export type { ErrorKind as QueryErrorKind } from "./kinds";
export { QueryError } from "./query";
export type {
  AnyDatabase,
  AnyRelation,
  AnySchema,
  AnySignature,
  QueryData,
  TypedContextQuery,
  TypedDelete,
  TypedInsert,
  TypedOperations,
  TypedQueryInstance,
  TypedRpc,
  TypedSelect,
  TypedTransaction,
  TypedUpdate,
  TypedUpsert,
} from "./typed";
export type {
  CompositeValue,
  ContextQuery,
  ContextSource,
  CountFrom,
  CountOf,
  DeleteInput,
  DeleteQuery,
  Embed,
  DefaultValue,
  Expression,
  Filter,
  FilterOp,
  FilterValue,
  FtsOp,
  FtsValue,
  InsertInput,
  InsertQuery,
  IsolationLevel,
  OperatorModifiers,
  OperatorSpec,
  OperatorValue,
  Operations,
  Order,
  Prepared,
  PreparedArgs,
  QueryFailed,
  QueryInput,
  QueryOk,
  QueryResult,
  QueryReturning,
  RpcInput,
  RpcQuery,
  SetInput,
  Scalar,
  Select,
  SelectInput,
  SelectQuery,
  Settled,
  Transaction,
  TransactionOptions,
  TransactionRetry,
  UpdateInput,
  UpdateQuery,
  UpsertInput,
  Where,
} from "./query";
export type { SchemaDescriptor } from "@tspg/core/schema";

/**
 * What `createQuery` takes: the database and the settings a query reads. There is nothing about HTTP
 * here -- that is `@tspg/rest`.
 */
export interface QueryOptions extends EngineOptions {
  /** A SQL function (`"auth.check_request"`) or callback to run in each call's transaction, before its statement. */
  readonly preRequest?: PreRequest;
  /**
   * The schema of the database, as generated at build time by `@tspg/query/types`. Giving it is
   * what makes the instance read nothing from the catalog, ever: not when it is created and not
   * while it runs. The descriptor is not checked -- the types are what keep a query and the schema
   * in step -- and the schemas it lists win over `schemas`, the first of them being the default one.
   *
   * Leaving it out is the other way round: the catalog is read once, on the first operation, for the
   * `schemas` given here. The queries are typed the same (`createQuery<Db>` is a type argument and
   * types never reach runtime), and the cost is a round trip at that first call, the catalog
   * permissions it needs, and a mismatch between `Db` and the live database becoming a runtime
   * error instead of an impossibility.
   */
  readonly schema?: SchemaDescriptor;
}

/**
 * The six operations -- `select`, `insert`, `upsert`, `update`, `delete` and `rpc` -- each taking an
 * object that describes the call, in-process: no `Request`, no URL, no HTTP status.
 *
 * A failure is part of the result, not an exception: `const { data, error } = await
 * pgRest.select({ table: "todos" })`. Exactly one of the two is set, so `if (error)` leaves
 * `data` non-null, and `error` is a {@link QueryError}: a `kind` to switch on, the `message`, `details`
 * and `hint`, the `sqlState` of a database error, and the input that produced it.
 *
 * An operation never rejects: an error the library did not foresee comes back as an `internal` `error`
 * carrying the original under `cause`, so checking `error` is enough and no `try`/`catch` is needed.
 * Its optional second argument is who is asking: `{ role, claims, settings }`.
 */
export interface QueryInstance extends Operations<"result", [ctx?: RequestContext]> {
  /** Run a call of a prepared query (see {@link QueryInstance.prepare}), with this context. */
  run<T, C extends number | undefined>(call: Prepared<T, C>, ctx?: RequestContext): Promise<QueryResult<T, C>>;
  /**
   * Plan a select once and get back a function that fills in its values: each call is string
   * concatenation and the statement for the driver, with no parsing and no planning. What it returns
   * is run with `run`: on the instance, as `tx.run` in a transaction, or on a `setContextQuery` function.
   *
   * ```ts ignore
   * const paidOver = pgRest.prepare((a: { status: string; min: number }) => ({
   *   table: "orders",
   *   columns: ["id", "total"],
   *   where: { status: a.status, total: { $gte: a.min } },
   *   order: ["total.desc"],
   * }));
   * const { data, error } = await pgRest.run(paidOver({ status: "paid", min: 100 }), ctx);
   * ```
   *
   * `build` runs once, with a stand-in for each argument, so an argument is a **filter value and
   * nothing else**: it cannot choose a column, an operator, a limit or the shape of the query, and
   * `build` cannot branch on it. Preparing fails (it throws, at set-up time) for a query that does
   * not follow that, a table that does not exist, or anything but a select. A call whose values change the SQL itself --
   * `null`, a `*` wildcard, a composite -- is not an error: it builds the query object and runs it
   * the ordinary way.
   */
  prepare<A extends PreparedArgs, T = unknown>(build: (args: A) => SelectInput): (args: A) => Prepared<T>;
  /**
   * The operations with the context decided once: `source` is either a fixed
   * {@link RequestContext} or a function called at every call, so an `AsyncLocalStorage` entered by
   * your middleware answers "who is asking" without threading `ctx` through every layer.
   *
   * ```ts ignore
   * const store = new AsyncLocalStorage<RequestContext>();
   * const db = pgRest.setContextQuery(() => store.getStore());
   * // in a middleware: store.run({ role: "authenticated", claims: { sub: userId } }, next)
   * const { data, error } = await db.select({ table: "todos" });
   * ```
   *
   * pg-rest holds no store of its own -- that keeps it dependency-free and runtime-neutral, and
   * lets the context come from anywhere, not just `node:async_hooks`.
   *
   * A context passed to the call wins over `source`, which is how an administrative query steps
   * out of the ambient context without leaving its scope. A `source` that returns nothing (the
   * store was never entered) is a `no_context` `error`, not a silent fall back to the anonymous
   * role. Like the instance's operations, it never rejects.
   */
  setContextQuery(source: ContextSource): ContextQuery;
  /**
   * Run several queries in **one** transaction: the context applied once for all of it, a commit
   * when the callback returns, a rollback when it throws -- two writes that must land together, in
   * the library rather than beside it.
   *
   * ```ts ignore
   * const { data, error } = await pgRest.transaction(async (tx) => {
   *   const order = await tx.insert({ table: "orders", rows: { client_id: 1 } });
   *   await tx.insert({ table: "order_items", rows: itemsFor(order.data.id) });
   *   return order.data;
   * }, { role: "authenticated", claims: { sub: user.id } });
   * ```
   *
   * A transaction's operations differ from {@link QueryInstance}'s in two ways, both of them consequences of
   * sharing a transaction. They take **no context**: the role and the claims are transaction-local
   * and issued once at the head of the transaction, so a per-call context would change the role for
   * every statement that follows instead of scoping anything. And they **reject** on failure instead
   * of answering an `error`, because a query that failed is a transaction that will not commit --
   * which makes their result the success, with `data` and `count` needing no narrowing.
   *
   * The scope is where the promise that does not reject lives: this answers a {@link QueryResult}
   * around whatever the callback returned -- `data` is that value, there is no `count` -- and the
   * failure that left it is its `error`. `tx.transaction()`, a savepoint, is how a query is allowed
   * to fail without taking the rest of the transaction with it.
   */
  transaction<A>(fn: (tx: Transaction) => Promise<A>, options?: TransactionOptions): Promise<QueryResult<A, undefined>>;
  /**
   * Read the catalog now, instead of on the first operation. Nothing to await on an instance given
   * a `schema` descriptor -- it has its schema already -- and the way to make a connection or
   * catalog problem surface at start-up on one that was not, rather than inside the first query.
   * It is also what {@link QueryInstance.prepare} needs, since planning is synchronous.
   */
  ready(): Promise<void>;
  /** Stop the instance. The database adapter is left open: close it yourself. */
  close(): Promise<void>;
}

export interface CreateQuery {
  (options: QueryOptions): QueryInstance;
  /**
   * With a database type from `generateTypes` (`@tspg/query/types`), the operations are typed by it: `table` and `name` are the ones that exist, `select`, `where` and `order` only
   * name real columns and relationships, and `data` is inferred from the `select`.
   */
  <Db extends AnyDatabase>(options: QueryOptions): TypedQueryInstance<Db>;
}

const create = (options: QueryOptions): QueryInstance => {
  // A descriptor decides both things: the cache is had without the catalog, and the schemas it was
  // generated for are the ones exposed. Without one, `schemas` says what to read and the read waits
  // for the first operation, so creating an instance stays synchronous either way.
  const given = options.schema ? fromDescriptor(options.schema) : undefined;
  const engine = given ? createStaticEngine({ ...options, schemas: given.schemas }, given) : createLazyEngine(options);
  const { adapter, config: shared } = engine;
  const config: QueryConfig = { ...shared, preRequest: options.preRequest };
  const cacheOf = async (): Promise<SchemaCache> => given ?? (await (engine as LazyEngine).ready());

  const execute = async <T = unknown>(
    input: QueryInput | Prepared<T>,
    ctx?: RequestContext,
  ): Promise<QueryResult<T>> => {
    try {
      return (await runQuery({ db: adapter, config, cache: await cacheOf() }, input, ctx ?? {})) as QueryResult<T>;
    } catch (e) {
      // runQuery does not throw; this covers everything around it (reading the catalog included, on
      // an instance with no descriptor), so the promise cannot reject
      return toFailedResult(input, e) as QueryResult<T>;
    }
  };

  const transaction = async <A>(
    fn: (tx: Transaction) => Promise<A>,
    scope?: TransactionOptions,
  ): Promise<QueryResult<A, undefined>> => {
    try {
      return await runTransaction<A>({ db: adapter, config, cache: await cacheOf() }, fn, scope);
    } catch (e) {
      // runTransaction does not throw; this covers everything around it, so the promise cannot reject
      return failedTransaction(e) as QueryResult<A, undefined>;
    }
  };

  const setContextQuery = (source: ContextSource): ContextQuery => {
    // The source is read per call, not once here: that is what makes an AsyncLocalStorage useful,
    // one bound `db` serving a different context for every request in flight.
    const call = async <T = unknown>(
      input: QueryInput | Prepared<T>,
      ctx?: RequestContext,
    ): Promise<QueryResult<T>> => {
      let context = ctx;
      if (!context) {
        try {
          context = await resolveContextSource(source);
        } catch (e) {
          return toFailedResult(input, e) as QueryResult<T>;
        }
        if (!context) return noContextResult(input) as QueryResult<T>;
      }
      return execute<T>(input, context);
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

    return {
      ...(operationsOf(call) as unknown as Operations<"result", [ctx?: RequestContext]>),
      run: call as ContextQuery["run"],
      transaction: bound,
    };
  };

  const prepare = <A extends PreparedArgs, T = unknown>(
    build: (args: A) => SelectInput,
  ): ((args: A) => Prepared<T>) => {
    // Planning is synchronous and needs the schema, which an instance with no descriptor only has
    // once it has read the catalog: `await instance.ready()` is how that happens before this point.
    const cache = given ?? engine.store.current();
    return prepareQuery({ db: adapter, config, cache }, build) as (args: A) => Prepared<T>;
  };

  return {
    ...(operationsOf(execute) as unknown as Operations<"result", [ctx?: RequestContext]>),
    run: execute as QueryInstance["run"],
    prepare,
    setContextQuery,
    transaction,
    ready: async () => void (await cacheOf()),
    close: async () => {},
  };
};

/**
 * Create the in-process query API over a Postgres database.
 *
 * `createQuery<Db>(options)` returns the same instance with its operations typed by a
 * generated database type; the cast is the whole of that difference, since types never reach
 * runtime and the two instances are one object.
 */
export const createQuery: CreateQuery = create as CreateQuery;
