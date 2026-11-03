import { Context, Data, Effect, Layer, Ref, Semaphore } from "effect";
import type { DbAdapter } from "./adapter";
import { type CoreConfig, type RequestContext, handleRequest } from "./core";
import { ApiError, DbQueryError, PgRestError, dbErrorToApiError } from "./errors";
import { type SchemaCache, introspect } from "./schema";

/** The Postgres connection. */
export class Db extends Context.Service<Db, DbAdapter>()("pg-rest/Db") {}

/** Resolved library configuration. */
export class Config extends Context.Service<Config, CoreConfig>()("pg-rest/Config") {}

export class SchemaLoadError extends Data.TaggedError("SchemaLoadError")<{
  readonly cause: unknown;
}> {}

/** Holds the schema cache; reloads are serialized and never discard a good cache on failure. */
export class SchemaStore extends Context.Service<
  SchemaStore,
  {
    readonly current: Effect.Effect<SchemaCache>;
    readonly reload: Effect.Effect<SchemaCache, SchemaLoadError>;
  }
>()("pg-rest/SchemaStore") {
  static readonly layer = Layer.effect(
    SchemaStore,
    Effect.gen(function* () {
      const db = yield* Db;
      const config = yield* Config;
      const load = Effect.tryPromise({
        try: () => introspect(db, config.schemas),
        catch: (cause) => new SchemaLoadError({ cause }),
      }).pipe(Effect.withSpan("pg-rest.schema.load"));

      const ref = yield* Ref.make(yield* load);
      const lock = yield* Semaphore.make(1);
      const reload = lock.withPermit(
        load.pipe(
          Effect.tap((cache) => Ref.set(ref, cache)),
          Effect.tapError((e) => Effect.logWarning("pg-rest: schema cache reload failed, keeping the previous cache", e.cause)),
        ),
      );
      return SchemaStore.of({ current: Ref.get(ref), reload });
    }),
  );
}

const CONNECTION_ERROR = /^(ERR_POSTGRES_(CONNECTION|AUTH|TLS|IDLE|LIFETIME)|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND)/;

/** Map anything thrown while handling a request to an {@link ApiError}. */
export const toApiError = (e: unknown, role: string, anonymousRole: string): ApiError => {
  if (e instanceof ApiError) return e;
  if (e instanceof PgRestError) return new ApiError({ status: e.status, body: e.body, headers: e.headers });
  if (e instanceof DbQueryError) return dbErrorToApiError(e, role, anonymousRole);
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONNECTION_ERROR.test(code)) {
    return new ApiError({
      status: 503,
      headers: {},
      body: { code: "PGRST001", message: "Database connection failed", details: e instanceof Error ? e.message : null, hint: null },
    });
  }
  return new ApiError({
    status: 500,
    headers: {},
    body: { code: "PGRSTX00", message: "Internal error", details: null, hint: null },
  });
};

export const errorResponse = (err: ApiError): Response =>
  new Response(JSON.stringify(err.body), {
    status: err.status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...err.headers },
  });

export class PgRest extends Context.Service<
  PgRest,
  {
    /** Handle a request. Never fails: errors become PostgREST-style JSON responses. */
    readonly handle: (request: Request, ctx?: RequestContext) => Effect.Effect<Response>;
    readonly reloadSchema: Effect.Effect<void, SchemaLoadError>;
    readonly schemaCache: Effect.Effect<SchemaCache>;
  }
>()("pg-rest/PgRest") {
  static readonly layer = Layer.effect(
    PgRest,
    Effect.gen(function* () {
      const db = yield* Db;
      const config = yield* Config;
      const store = yield* SchemaStore;

      const handle = Effect.fn("PgRest.handle")(function* (request: Request, ctx: RequestContext = {}) {
        const cache = yield* store.current;
        const role = ctx.role ?? config.anonymousRole;
        return yield* Effect.tryPromise({
          try: () => handleRequest({ db, config, cache }, request, ctx),
          catch: (e) => e,
        }).pipe(
          Effect.catch((e) =>
            Effect.gen(function* () {
              const api = toApiError(e, role, config.anonymousRole);
              if (api.status >= 500 && !(e instanceof PgRestError) && !(e instanceof DbQueryError)) {
                yield* Effect.logError("pg-rest: unexpected error while handling a request", e);
              }
              return errorResponse(api);
            }),
          ),
        );
      });

      return PgRest.of({
        handle,
        reloadSchema: store.reload.pipe(Effect.asVoid),
        schemaCache: store.current,
      });
    }),
  );
}
