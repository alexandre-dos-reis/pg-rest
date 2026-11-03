import type { DbAdapter, DbSession, Row } from "../adapter";

/** The subset of PGlite (`@electric-sql/pglite`) that is used. */
interface PGliteQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}
interface PGliteLike extends PGliteQueryable {
  transaction<T>(fn: (tx: PGliteQueryable) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

const session = (db: PGliteQueryable): DbSession => ({
  async query(text, params) {
    return (await db.query(text, params ? [...params] : [])).rows;
  },
});

/**
 * pg-rest adapter for PGlite (Postgres in WebAssembly): no server, ideal for tests, demos and local-first apps.
 *
 * ```ts
 * import { PGlite } from "@electric-sql/pglite";
 * const api = await createPgRest({ db: pgliteAdapter(new PGlite()), schemas: ["api"] });
 * ```
 */
export const pgliteAdapter = (db: PGliteLike): DbAdapter => ({
  query: session(db).query,
  transaction: (fn) => db.transaction((tx) => fn(session(tx))),
  ...(db.close ? { close: () => db.close!() } : {}),
});
