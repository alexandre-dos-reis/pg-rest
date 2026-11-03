import { DbQueryError } from "../errors";
import type { DbAdapter, DbSession, Row } from "../adapter";

/** The subset of `Bun.SQL` that we use (kept structural to avoid a hard dep). */
interface BunSqlLike {
  unsafe(query: string, values?: any[]): PromiseLike<any>;
  begin<T>(fn: (tx: BunSqlLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const toDbError = (e: any): unknown => {
  // Bun's PostgresError carries the SQLSTATE in `errno`.
  if (e && typeof e === "object" && typeof e.errno === "string" && e.errno.length === 5) {
    return new DbQueryError(e.errno, String(e.message ?? ""), e.detail, e.hint);
  }
  return e;
};

const makeSession = (sql: BunSqlLike): DbSession => ({
  async query(text, params) {
    try {
      const res = await sql.unsafe(text, params ? [...params] : undefined);
      return Array.from(res as Iterable<Row>);
    } catch (e) {
      throw toDbError(e);
    }
  },
});

/**
 * Adapter for Bun's built-in Postgres client.
 *
 * ```ts
 * import { SQL } from "bun";
 * const db = bunSqlAdapter(new SQL("postgres://..."));
 * ```
 * Or pass a connection string and one is created for you.
 */
export const bunSqlAdapter = (client: BunSqlLike | string): DbAdapter => {
  let sql: BunSqlLike;
  if (typeof client === "string") {
    const Bun = (globalThis as any).Bun;
    if (!Bun?.SQL) {
      throw new Error("bunSqlAdapter(connectionString) requires the Bun runtime");
    }
    sql = new Bun.SQL(client) as BunSqlLike;
  } else {
    sql = client;
  }
  const base = makeSession(sql);
  return {
    query: base.query,
    async transaction(fn) {
      try {
        return await sql.begin((tx) => fn(makeSession(tx)));
      } catch (e) {
        throw toDbError(e);
      }
    },
    close: () => sql.close(),
  };
};
