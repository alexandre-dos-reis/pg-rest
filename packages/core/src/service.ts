import type { DbAdapter } from "./adapter";
import { ApiError, DbQueryError, PgRestError, dbErrorToApiError } from "./errors";
import { type SchemaCache, introspect } from "./schema";

/** The schema could not be read from the database catalog. */
export class SchemaLoadError extends Error {
  readonly _tag = "SchemaLoadError";
  constructor(override readonly cause: unknown) {
    super(`pg-rest: could not load the database schema: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SchemaLoadError";
  }
}

/** Holds the schema cache; reloads are serialized and never discard a good cache on failure. */
export interface SchemaStore {
  current(): SchemaCache;
  reload(): Promise<SchemaCache>;
}

export const createSchemaStore = async (db: DbAdapter, schemas: ReadonlyArray<string>): Promise<SchemaStore> => {
  const load = () =>
    introspect(db, schemas).catch((cause: unknown) => {
      throw new SchemaLoadError(cause);
    });
  let cache = await load();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    current: () => cache,
    reload() {
      const run = queue.then(async () => {
        try {
          cache = await load();
          return cache;
        } catch (e) {
          console.warn("pg-rest: schema cache reload failed, keeping the previous cache", (e as SchemaLoadError).cause);
          throw e;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
};

const CONNECTION_ERROR = /^(ERR_POSTGRES_(CONNECTION|AUTH|TLS|IDLE|LIFETIME)|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND)/;

/** Map anything thrown while handling a request to an {@link ApiError}. */
export const toApiError = (e: unknown, role: string | undefined, anonymousRole: string | undefined): ApiError => {
  if (e instanceof ApiError) return e;
  if (e instanceof PgRestError) return new ApiError({ status: e.status, body: e.body, headers: e.headers });
  if (e instanceof DbQueryError) return dbErrorToApiError(e, role, anonymousRole);
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONNECTION_ERROR.test(code)) {
    return new ApiError({
      status: 503,
      headers: {},
      body: {
        code: "PGRST001",
        message: "Database connection failed",
        details: e instanceof Error ? e.message : null,
        hint: null,
      },
    });
  }
  return new ApiError({
    status: 500,
    headers: {},
    body: { code: "PGRSTX00", message: "Internal error", details: null, hint: null },
  });
};
