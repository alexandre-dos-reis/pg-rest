import type { DbAdapter, DbSession, Row } from "../../src/adapter";

/** The subset of `Bun.SQL` that is used (structural: no import from "bun" needed). */
interface BunSqlLike {
  unsafe(query: string, values?: any[]): PromiseLike<any>;
  begin<T>(fn: (tx: BunSqlLike) => Promise<T>): Promise<T>;
}

const session = (sql: BunSqlLike): DbSession => ({
  async query(text, params) {
    const res = await sql.unsafe(text, params ? [...params] : undefined);
    return Array.from(res as Iterable<Row>);
  },
});

/**
 * pg-rest adapter for Bun's built-in Postgres client.
 *
 * ```ts
 * import { SQL } from "bun";
 * const sql = new SQL(process.env.DATABASE_URL!);
 * const api = await createPgRest({ db: bunSqlAdapter(sql), schemas: ["api"] });
 * ```
 */
export const bunSqlAdapter = (sql: BunSqlLike & { close?(): Promise<void> }): DbAdapter => ({
  query: session(sql).query,
  transaction: (fn) => sql.begin((tx) => fn(session(tx))),
  ...(sql.close ? { close: () => sql.close!() } : {}),
});
