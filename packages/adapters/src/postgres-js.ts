import type { DbAdapter, DbSession, Row } from ".";

/** All that is needed to run a query, inside a transaction or outside one. */
interface PostgresJsQueryable {
  unsafe(query: string, params?: any[]): PromiseLike<any>;
}

/** The subset of postgres.js (`postgres`) that is used. */
interface PostgresJsLike extends PostgresJsQueryable {
  // Not PostgresJsLike: postgres.js passes a TransactionSql here, which has no `end`.
  begin<T>(fn: (tx: PostgresJsQueryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

const session = (sql: PostgresJsQueryable): DbSession => ({
  async query(text, params) {
    return Array.from((await sql.unsafe(text, params ? [...params] : [])) as Iterable<Row>);
  },
});

/**
 * pg-rest adapter for postgres.js.
 *
 * ```ts
 * import postgres from "postgres";
 * const sql = postgres(process.env.DATABASE_URL!);
 * const api = await createPgRest({ db: postgresJsAdapter(sql), schemas: ["api"] });
 * ```
 */
export const postgresJsAdapter = (sql: PostgresJsLike): DbAdapter => ({
  query: session(sql).query,
  transaction: (fn) => sql.begin((tx) => fn(session(tx))),
  close: () => sql.end(),
});
