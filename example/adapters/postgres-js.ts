import type { DbAdapter, DbSession, Row } from "../../src/adapter";

/** The subset of postgres.js (`postgres`) that is used. */
interface PostgresJsLike {
  unsafe(query: string, params?: any[]): PromiseLike<any>;
  begin<T>(fn: (tx: PostgresJsLike) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

const session = (sql: PostgresJsLike): DbSession => ({
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
