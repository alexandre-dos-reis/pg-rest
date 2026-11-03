/** A row returned by the database. */
export type Row = Record<string, unknown>;

/** Something that can run a single SQL statement. */
export interface DbSession {
  /**
   * Run one statement. Only plain `text` parameters are ever passed, and each
   * one is explicitly cast in SQL (`$1::text`), so adapters need no type
   * inference. Throw a {@link DbQueryError} on database errors.
   */
  query(text: string, params?: ReadonlyArray<string | null>): Promise<Row[]>;
}

/**
 * The only thing pg-rest needs from a Postgres driver. Implement it to plug in
 * any driver (Bun.sql, postgres.js, node-postgres, PGlite...).
 */
export interface DbAdapter extends DbSession {
  /**
   * Run `fn` in a single transaction on one connection. Commit when it
   * resolves, roll back when it throws (and rethrow).
   */
  transaction<A>(fn: (session: DbSession) => Promise<A>): Promise<A>;
  /** Release resources. Optional. */
  close?(): Promise<void>;
}
