import type { DbAdapter, DbSession, Row } from "../adapter";

/** The subset of node-postgres (`pg`) that is used. */
interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgClientLike & { release(): void }>;
  end(): Promise<void>;
}

const session = (c: PgClientLike): DbSession => ({
  async query(text, params) {
    return (await c.query(text, params ? [...params] : [])).rows;
  },
});

/**
 * pg-rest adapter for node-postgres. Works on Node.js, Deno, Bun...
 *
 * ```ts
 * import pg from "pg";
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * const api = await createPgRest({ db: nodePostgresAdapter(pool), schemas: ["api"] });
 * ```
 */
export const nodePostgresAdapter = (pool: PgPoolLike): DbAdapter => ({
  query: session(pool).query,
  async transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(session(client));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },
  close: () => pool.end(),
});
