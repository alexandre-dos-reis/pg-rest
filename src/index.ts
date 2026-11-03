import { Effect, Layer, ManagedRuntime } from "effect";
import type { DbAdapter } from "./adapter";
import type { CoreConfig, RequestContext } from "./core";
import { ApiError, PgRestError, normalizeDbError } from "./errors";
import type { SchemaCache } from "./schema";
import { Config, Db, PgRest, SchemaStore, errorResponse, toApiError } from "./service";

export type { DbAdapter, DbSession, Row } from "./adapter";
export type { PreRequestInfo, RequestContext } from "./core";
export { ApiError, DbQueryError, PgRestError } from "./errors";
export type { ErrorBody } from "./errors";
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
  /** Role used when the request context has none. Default `"anon"`. */
  readonly anonymousRole?: string;
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
  /** Re-read the database catalog (after migrations). */
  reloadSchema(): Promise<void>;
  /** The current introspected schema. */
  schemaCache(): Promise<SchemaCache>;
  /** Stop the handler. The database adapter is left open: close it yourself. */
  close(): Promise<void>;
}

const UNEXPOSABLE = new Set(["pg_catalog", "information_schema"]);

/** Create a PostgREST-compatible handler over a Postgres database. */
export const createPgRest = async (options: PgRestOptions): Promise<PgRestInstance> => {
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
    anonymousRole: options.anonymousRole ?? "anon",
    maxRows: options.maxRows,
    basePath: options.basePath ?? "",
    extraSearchPath: options.extraSearchPath ?? ["public"],
    allowTxOverride: options.allowTxOverride ?? false,
    openApi: options.openApi ?? true,
    requestSettings: options.requestSettings ?? true,
    preRequest: options.preRequest,
    serverUrl: options.serverUrl,
  };

  const DbLive = Layer.effect(
    Db,
    Effect.succeed(adapter),
  );
  const base = Layer.mergeAll(DbLive, Layer.succeed(Config, config));
  const storeLayer = SchemaStore.layer.pipe(Layer.provideMerge(base));
  const mainLayer = PgRest.layer.pipe(Layer.provide(storeLayer));

  const runtime = ManagedRuntime.make(mainLayer);
  try {
    // Build the layers now so connection or catalog problems surface at startup.
    await runtime.runPromise(PgRest.use((s) => s.schemaCache));
  } catch (e) {
    await runtime.dispose();
    throw e;
  }

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
    return runtime.runPromise(PgRest.use((s) => s.handle(request, context ?? {})));
  };

  return {
    handle,
    reloadSchema: () => runtime.runPromise(PgRest.use((s) => s.reloadSchema)),
    schemaCache: () => runtime.runPromise(PgRest.use((s) => s.schemaCache)),
    close: () => runtime.dispose(),
  };
};
