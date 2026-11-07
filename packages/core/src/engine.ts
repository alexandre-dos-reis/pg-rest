import type { DbAdapter, DbSession } from "./adapter";
import type { CoreConfig } from "./core";
import { normalizeDbError } from "./errors";
import { type SchemaStore, createSchemaStore } from "./service";

/** What the two entry points (`@tsql/rest`'s `handle`, `@tsql/query`'s `query`) have in common. */
export interface EngineOptions {
  /**
   * The database, as a {@link DbAdapter} you create from your driver
   * (Bun.sql, node-postgres, postgres.js, PGlite...). It is never closed by the library:
   * you own its lifecycle.
   */
  readonly db: DbAdapter;
  /** Schemas to expose. The first one is the default. Default `["public"]`. */
  readonly schemas?: ReadonlyArray<string>;
  /**
   * Role used when the request context has none. Default `"anon"`. `false` refuses anonymous requests
   * with `401 PGRST302` (like PostgREST without `db-anon-role`).
   */
  readonly anonymousRole?: string | false;
  /** Maximum rows returned by a read (PostgREST `db-max-rows`). */
  readonly maxRows?: number;
  /** Appended to `search_path` after the selected schema. Default `["public"]`. */
  readonly extraSearchPath?: ReadonlyArray<string>;
  /** A SQL function (`"auth.check_request"`) or callback to run before each request (PostgREST `db-pre-request`). */
  readonly preRequest?: CoreConfig["preRequest"];
}

/** What an instance is built on: the database, the settings both entry points read, the schema cache. */
export interface Engine {
  readonly adapter: DbAdapter;
  readonly config: CoreConfig;
  readonly store: SchemaStore;
}

const UNEXPOSABLE = new Set(["pg_catalog", "information_schema"]);

export const createEngine = async (options: EngineOptions): Promise<Engine> => {
  const schemas = options.schemas?.length ? [...options.schemas] : ["public"];
  for (const s of schemas) {
    if (UNEXPOSABLE.has(s)) {
      throw new Error(`pg-rest: the schema "${s}" cannot be exposed`);
    }
  }
  const user = options.db;
  // Driver errors are recognised by their SQLSTATE, whatever the driver, so adapters stay trivial.
  // Every statement is normalised where it is issued, and not only on the way out of a
  // transaction: inside a scope the failure is caught before it reaches that boundary.
  const normalized = (s: DbSession): DbSession => ({
    async query(text, params) {
      try {
        return await s.query(text, params);
      } catch (e) {
        throw normalizeDbError(e);
      }
    },
  });
  const adapter: DbAdapter = {
    query: normalized(user).query,
    async transaction(fn) {
      try {
        return await user.transaction((s) => fn(normalized(s)));
      } catch (e) {
        throw normalizeDbError(e);
      }
    },
  };

  const config: CoreConfig = {
    schemas,
    anonymousRole: options.anonymousRole === false ? undefined : (options.anonymousRole ?? "anon"),
    maxRows: options.maxRows,
    extraSearchPath: options.extraSearchPath ?? ["public"],
    preRequest: options.preRequest,
  };

  // Read the catalog now so connection or catalog problems surface at startup.
  const store = await createSchemaStore(adapter, schemas);
  return { adapter, config, store };
};
