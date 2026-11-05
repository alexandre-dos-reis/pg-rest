import type { DbAdapter } from "./adapter";
import type { CoreConfig, RequestContext } from "./core";
import { ApiError, normalizeDbError } from "./errors";
import {
  type QueryInput,
  type QueryResult,
  type QuerySafeResult,
  runQuery,
  runQuerySafe,
  toSafeFailure,
} from "./query";
import type { SchemaCache } from "./schema";
import type { GenerateTypesOptions } from "./types";
import type { AnyDatabase, TypedPgRestInstance } from "./typed";
import { createSchemaStore, errorResponse, handleSafely, toApiError } from "./service";

export type { DbAdapter, DbSession, Row } from "./adapter";
export type { PreRequestInfo, RequestContext } from "./core";
export { ApiError, DbQueryError, PgRestError } from "./errors";
export type { ErrorBody } from "./errors";
export { QueryError } from "./query";
export type {
  AnyDatabase,
  AnyRelation,
  AnySchema,
  AnySignature,
  QueryData,
  TypedPgRestInstance,
  TypedQuery,
} from "./typed";
export type {
  DeleteQuery,
  Embed,
  Filter,
  FilterOp,
  FilterSpec,
  InsertQuery,
  Order,
  QueryInput,
  QueryResult,
  QueryReturning,
  QuerySafeResult,
  RpcQuery,
  Scalar,
  Select,
  SelectQuery,
  UpdateQuery,
  Where,
} from "./query";
export type { Column, ForeignKey, FunctionDef, Relation, SchemaCache } from "./schema";
export { SchemaLoadError } from "./service";

export interface PgRestOptions {
  /**
   * The database, as a {@link DbAdapter} you create from your driver
   * (Bun.sql, node-postgres, postgres.js, PGlite...). See `example/adapters`.
   * pg-rest never closes it: you own its lifecycle.
   */
  readonly db: DbAdapter;
  /** Schemas to expose. The first one is the default. Default `["public"]`. */
  readonly schemas?: ReadonlyArray<string>;
  /**
   * Role used when the request context has none. Default `"anon"`. `false` refuses anonymous requests
   * with `401 PGRST302` (like PostgREST without `db-anon-role`).
   */
  readonly anonymousRole?: string | false;
  /**
   * Decide who is calling. Return the role and claims (what RLS policies read
   * from `request.jwt.claims`). There is no JWT: use a session cookie, an API
   * key, your auth library... Throw a {@link PgRestError} to reject the request
   * (e.g. `new PgRestError(401, "unauthorized", "Please sign in")`).
   *
   * Used by `handle(request)` when no explicit context is passed.
   */
  readonly resolveContext?: (request: Request) => RequestContext | undefined | Promise<RequestContext | undefined>;
  /** Maximum rows returned by a read (PostgREST `db-max-rows`). */
  readonly maxRows?: number;
  /** Mount path to strip from request URLs, e.g. `/api`. */
  readonly basePath?: string;
  /** Appended to `search_path` after the selected schema. Default `["public"]`. */
  readonly extraSearchPath?: ReadonlyArray<string>;
  /** Honor `Prefer: tx=rollback` (PostgREST `db-tx-end`). Default `false`. */
  readonly allowTxOverride?: boolean;
  /**
   * Answer `Accept: application/vnd.pgrst.plan` requests with the query plan (PostgREST `db-plan-enabled`).
   * A plan reveals the structure of the database: keep it off, or restrict it, in production. Default `false`.
   */
  readonly planEnabled?: boolean;
  /** Serve the OpenAPI document at `/`. Default `true`. */
  readonly openApi?: boolean;
  /** Expose `request.headers`, `request.cookies`, `request.method`, `request.path` to SQL. Default `true`. */
  readonly requestSettings?: boolean;
  /** A SQL function (`"auth.check_request"`) or callback to run before each request (PostgREST `db-pre-request`). */
  readonly preRequest?: CoreConfig["preRequest"];
  /** Public URL, used as `host` in the OpenAPI document. Defaults to the request origin. */
  readonly serverUrl?: string;
}

export interface PgRestInstance {
  /**
   * Handle a request. Pass `ctx` to set the user explicitly; otherwise
   * `resolveContext` is used; otherwise the request runs as the anonymous role.
   */
  handle(request: Request, ctx?: RequestContext): Promise<Response>;
  /**
   * Run a query described by an object, in-process: no `Request`, no URL, no HTTP status.
   * It goes through the same parser, the same SQL and the same error mapping as
   * {@link PgRestInstance.handle}, so the database sees the same thing either way.
   *
   * Only the HTTP envelope is gone, which is also what it cannot do: content negotiation
   * (CSV, GeoJSON, custom media types), `EXPLAIN` plans and OpenAPI stay on `handle`.
   *
   * Failures throw a {@link QueryError}: an `Error` carrying the PostgREST status, body
   * (`code`, `message`, `details`, `hint`) and the input that produced it.
   */
  query<T = unknown>(input: QueryInput, ctx?: RequestContext): Promise<QueryResult<T>>;
  /**
   * {@link PgRestInstance.query} with the failure as a value instead of an exception:
   * `const { data, error } = await pgRest.querySafe({ table: "todos" })`. Exactly one of the two
   * is set, so `if (error)` leaves `data` non-null. The error is the same {@link QueryError}.
   *
   * It never rejects: an error the library did not foresee comes back as a 500 `error` carrying the
   * original under `cause`, so checking `error` is enough and no `try`/`catch` is needed.
   */
  querySafe<T = unknown>(input: QueryInput, ctx?: RequestContext): Promise<QuerySafeResult<T>>;
  /** Re-read the database catalog (after migrations). */
  reloadSchema(): Promise<void>;
  /** The current introspected schema. */
  schemaCache(): Promise<SchemaCache>;
  /**
   * TypeScript types for this database, as the text of a module. Write it next to your code, keep
   * it in version control, and hand the type it exports to `createPgRest<Database>` so queries
   * check themselves. Run it again after a migration.
   *
   * ```ts
   * writeFileSync("src/db.types.ts", await pgRest.generateTypes({ name: "Database" }));
   * ```
   *
   * The generator is loaded on demand, so a server that never calls this never pays for it. The
   * same function is exported standalone as `@adrdp/pg-rest/types` for when you hold a
   * {@link SchemaCache} rather than an instance.
   */
  generateTypes(options?: GenerateTypesOptions): Promise<string>;
  /** Stop the handler. The database adapter is left open: close it yourself. */
  close(): Promise<void>;
}

const UNEXPOSABLE = new Set(["pg_catalog", "information_schema"]);

export interface CreatePgRest {
  (options: PgRestOptions): Promise<PgRestInstance>;
  /**
   * With a database type from `generateTypes` (`@adrdp/pg-rest/types`), `query` and `querySafe`
   * are typed by it: `table` and `rpc` are the ones that exist, `select`, `where` and `order` only
   * name real columns and relationships, and `data` is inferred from the `select`.
   */
  <Db extends AnyDatabase>(options: PgRestOptions): Promise<TypedPgRestInstance<Db>>;
}

const create = async (options: PgRestOptions): Promise<PgRestInstance> => {
  const schemas = options.schemas?.length ? [...options.schemas] : ["public"];
  for (const s of schemas) {
    if (UNEXPOSABLE.has(s)) {
      throw new Error(`pg-rest: the schema "${s}" cannot be exposed`);
    }
  }
  const user = options.db;
  // Driver errors are recognised by their SQLSTATE, whatever the driver, so adapters stay trivial.
  const adapter: DbAdapter = {
    async query(text, params) {
      try {
        return await user.query(text, params);
      } catch (e) {
        throw normalizeDbError(e);
      }
    },
    async transaction(fn) {
      try {
        return await user.transaction(fn);
      } catch (e) {
        throw normalizeDbError(e);
      }
    },
  };

  const config: CoreConfig = {
    schemas,
    anonymousRole: options.anonymousRole === false ? undefined : (options.anonymousRole ?? "anon"),
    maxRows: options.maxRows,
    basePath: options.basePath ?? "",
    extraSearchPath: options.extraSearchPath ?? ["public"],
    allowTxOverride: options.allowTxOverride ?? false,
    planEnabled: options.planEnabled ?? false,
    openApi: options.openApi ?? true,
    requestSettings: options.requestSettings ?? true,
    preRequest: options.preRequest,
    serverUrl: options.serverUrl,
  };

  // Read the catalog now so connection or catalog problems surface at startup.
  const store = await createSchemaStore(adapter, schemas);

  const handle = async (request: Request, ctx?: RequestContext): Promise<Response> => {
    let context = ctx;
    if (!context && options.resolveContext) {
      try {
        context = await options.resolveContext(request);
      } catch (e) {
        const api = e instanceof ApiError ? e : toApiError(e, config.anonymousRole, config.anonymousRole);
        return errorResponse(api);
      }
    }
    return handleSafely({ db: adapter, config, cache: store.current() }, request, context ?? {});
  };

  const query = async <T = unknown>(input: QueryInput, ctx?: RequestContext): Promise<QueryResult<T>> =>
    (await runQuery({ db: adapter, config, cache: store.current() }, input, ctx ?? {})) as QueryResult<T>;

  const querySafe = async <T = unknown>(input: QueryInput, ctx?: RequestContext): Promise<QuerySafeResult<T>> => {
    try {
      return (await runQuerySafe(
        { db: adapter, config, cache: store.current() },
        input,
        ctx ?? {},
      )) as QuerySafeResult<T>;
    } catch (e) {
      // runQuerySafe does not throw; this covers everything around it, so the promise cannot reject
      return toSafeFailure(input, e) as QuerySafeResult<T>;
    }
  };

  return {
    handle,
    query,
    querySafe,
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
 * Create a PostgREST-compatible handler over a Postgres database.
 *
 * `createPgRest<Db>(options)` returns the same instance with `query` and `querySafe` typed by a
 * generated database type; the cast is the whole of that difference, since types never reach
 * runtime and the two instances are one object.
 */
export const createPgRest: CreatePgRest = create as CreatePgRest;
