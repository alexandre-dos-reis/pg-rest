import type { DbAdapter, DbSession } from "@tspg/adapters";
import type { CoreConfig } from "./core";
import { normalizeDbError } from "./errors";
import type { SchemaCache } from "./schema";
import { type SchemaStore, createSchemaStore } from "./service";

/** What the two entry points (`@tspg/rest`'s `handle`, `@tspg/query`'s `query`) have in common. */
export interface EngineOptions {
  /**
   * The database, as a {@link DbAdapter} you create from your driver
   * (Bun.sql, node-postgres, postgres.js, PGlite...). Closing the instance closes it, unless
   * {@link EngineOptions.onClose} says otherwise.
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
  /**
   * What closing the instance does to the driver. Without it, `close()` calls the adapter's own
   * `close()` (`pool.end()`, `sql.end()`, `pglite.close()`...), which is what a driver created for
   * this instance and nothing else wants.
   *
   * Give it to take that over -- the adapter is handed back as `db`, and what you do with it is the
   * whole of what closing does:
   *
   * ```ts ignore
   * // one pool, two instances: whichever closes first must not end it under the other
   * const db = nodePostgresAdapter(pool);
   * const api = await createRest({ db, onClose: () => {} });
   * const query = createQuery({ db });   // this one ends the pool
   * ```
   *
   * It is called once, however many times `close()` is called.
   */
  readonly onClose?: (ctx: { readonly db: DbAdapter }) => void | Promise<void>;
}

/** What an instance is built on: the database, the settings both entry points read, the schema cache. */
export interface Engine {
  readonly adapter: DbAdapter;
  readonly config: CoreConfig;
  readonly store: SchemaStore;
  /**
   * Close the driver: `onClose` if it was given, the adapter's own `close()` otherwise (nothing, if
   * it has none). Called more than once, it does its work on the first call only.
   */
  close(): Promise<void>;
}

const staticStore = (cache: SchemaCache): SchemaStore => ({ current: () => cache, reload: async () => cache });

const UNEXPOSABLE = new Set(["pg_catalog", "information_schema"]);

const build = (options: EngineOptions): Pick<Engine, "adapter" | "config" | "close"> => {
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

  // The wrapped adapter is not the one closed: `close` belongs to the driver the caller built, and
  // only `query`/`transaction` are normalised above.
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // `onClose` is the caller's code: what it throws is theirs to see. The default is the library
    // closing something it did not open, where a driver already ended -- `pool.end()` twice, a
    // process shutting down in both directions -- is the ordinary case and not a failure.
    if (options.onClose) return void (await options.onClose({ db: user }));
    try {
      await user.close?.();
    } catch {
      // already closed, or closing twice: there is nothing left to do and nobody to tell
    }
  };

  return { adapter, config, close };
};

/** The catalog is read now, so connection or catalog problems surface at startup; `reload()` reads it again. */
export const createEngine = async (options: EngineOptions): Promise<Engine> => {
  const { adapter, config, close } = build(options);
  return { adapter, config, close, store: await createSchemaStore(adapter, config.schemas) };
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
  const { adapter, config, close } = build(options);
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
    close,
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
