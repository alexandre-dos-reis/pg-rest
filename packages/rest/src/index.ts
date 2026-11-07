import type { RequestContext } from "@tsql/core/core";
import { type EngineOptions, createEngine } from "@tsql/core/engine";
import { ApiError } from "@tsql/core/errors";
import type { SchemaCache } from "@tsql/core/schema";
import { toApiError } from "@tsql/core/service";
import type { HttpConfig } from "./http";
import { errorResponse, handleSafely } from "./serve";

export type { DbAdapter, DbSession, Row } from "@tsql/core/adapter";
export type { PreRequestInfo, RequestContext } from "@tsql/core/core";
export type { EngineOptions } from "@tsql/core/engine";
export { ApiError, DbQueryError, PgRestError, describeErrorKind, errorKind } from "@tsql/core/errors";
export type { ErrorBody, QueryErrorKind } from "@tsql/core/errors";
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

/**
 * What `createRest` takes: the database and the settings both entry points share ({@link EngineOptions}),
 * and what is about HTTP.
 */
export interface RestOptions extends EngineOptions {
  /**
   * Decide who is calling. Return the role and claims (what RLS policies read
   * from `request.jwt.claims`). There is no JWT: use a session cookie, an API
   * key, your auth library... Throw a {@link PgRestError} to reject the request
   * (e.g. `new PgRestError(401, "unauthorized", "Please sign in")`).
   *
   * Used by `handle(request)` when no explicit context is passed.
   */
  readonly resolveContext?: (request: Request) => RequestContext | undefined | Promise<RequestContext | undefined>;
  /** Mount path to strip from request URLs, e.g. `/api`. */
  readonly basePath?: string;
  /** Honor `Prefer: tx=rollback` (PostgREST `db-tx-end`). Default `false`. */
  readonly allowTxOverride?: boolean;
  /**
   * Answer `Accept: application/vnd.pgrst.plan` requests with the query plan (PostgREST `db-plan-enabled`).
   * A plan reveals the structure of the database: keep it off, or restrict it, in production. Default `false`.
   */
  readonly planEnabled?: boolean;
  /** Serve the OpenAPI document at `/`. Default `true`. */
  readonly openApi?: boolean;
  /** Public URL, used as `host` in the OpenAPI document. Defaults to the request origin. */
  readonly serverUrl?: string;
}

export interface RestInstance {
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

/**
 * Create a PostgREST-compatible handler over a Postgres database: `handle(Request) => Response`.
 *
 * What it does is PostgREST's, status codes, headers and error bodies included. The in-process
 * `query()` API is `@tsql/query`.
 */
export const createRest = async (options: RestOptions): Promise<RestInstance> => {
  const { adapter, config: shared, store } = await createEngine(options);
  const config: HttpConfig = {
    ...shared,
    basePath: options.basePath ?? "",
    allowTxOverride: options.allowTxOverride ?? false,
    planEnabled: options.planEnabled ?? false,
    openApi: options.openApi ?? true,
    serverUrl: options.serverUrl,
  };

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

  return {
    handle,
    reloadSchema: async () => void (await store.reload()),
    schemaCache: async () => store.current(),
    close: async () => {},
  };
};
