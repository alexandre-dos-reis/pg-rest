import type { DbAdapter, DbSession } from "@tspg/adapters";
import type { CoreConfig } from "./core";
import { normalizeDbError } from "./errors";
import type { SchemaCache } from "./schema";
import { type SchemaStore, createSchemaStore } from "./service";

/** What the two entry points (`@tspg/rest`'s `handle`, `@tspg/query`'s `query`) have in common. */
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
   * Role used when the context has none. Default `"anon"`. `false` refuses anonymous calls:
   * a call with no role is an error (`unauthenticated` in `@tspg/query`, a `401` in `@tspg/rest`).
   */
  readonly anonymousRole?: string | false;
  /** Maximum rows returned by a read. */
  readonly maxRows?: number;
  /** Appended to `search_path` after the selected schema. Default `["public"]`. */
  readonly extraSearchPath?: ReadonlyArray<string>;
}

/** What an instance is built on: the database, the settings both entry points read, the schema cache. */
export interface Engine {
  readonly adapter: DbAdapter;
  readonly config: CoreConfig;
  readonly store: SchemaStore;
}

const staticStore = (cache: SchemaCache): SchemaStore => ({ current: () => cache, reload: async () => cache });

const UNEXPOSABLE = new Set(["pg_catalog", "information_schema"]);

const build = (options: EngineOptions): Pick<Engine, "adapter" | "config"> => {
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
  };

  return { adapter, config };
};

/** The catalog is read now, so connection or catalog problems surface at startup; `reload()` reads it again. */
export const createEngine = async (options: EngineOptions): Promise<Engine> => {
  const { adapter, config } = build(options);
  return { adapter, config, store: await createSchemaStore(adapter, config.schemas) };
};

/** A cache already in hand (from a generated descriptor): the catalog is never read. */
export const createStaticEngine = (options: EngineOptions, schema: SchemaCache): Engine => ({
  ...build(options),
  store: staticStore(schema),
});

/** An engine whose catalog has not been read yet: {@link LazyEngine.ready} reads it, once. */
export interface LazyEngine extends Engine {
  /**
   * The cache, reading the catalog on the first call and answering the same one afterwards.
   * Concurrent callers share the single read; a read that failed is not remembered, so the next
   * call tries again.
   */
  ready(): Promise<SchemaCache>;
}

/**
 * Nothing is read here: the catalog is read on the first {@link LazyEngine.ready}, which is what
 * lets an entry point be created synchronously and still work from the live catalog. `store.current()`
 * throws until that first read has happened -- `ready()` is the way in.
 */
export const createLazyEngine = (options: EngineOptions): LazyEngine => {
  const { adapter, config } = build(options);
  let loaded: SchemaStore | undefined;
  let loading: Promise<SchemaStore> | undefined;
  const load = (): Promise<SchemaStore> => {
    loading ??= createSchemaStore(adapter, config.schemas).then(
      (s) => {
        loaded = s;
        return s;
      },
      (e: unknown) => {
        // A failed read is forgotten rather than cached: the database being unreachable for one
        // call must not make every later call fail on that same rejection.
        loading = undefined;
        throw e;
      },
    );
    return loading;
  };
  return {
    adapter,
    config,
    store: {
      current: () => {
        if (!loaded) throw new Error("pg-rest: the schema has not been read yet (await ready() first)");
        return loaded.current();
      },
      reload: async () => (await load()).reload(),
    },
    ready: async () => (await load()).current(),
  };
};
