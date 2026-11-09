import type { ParsedQuery } from "../../src/parse/filter";

/**
 * `ParsedQuery` as plain data, so it can be committed and compared.
 *
 * This is the boundary both published packages meet at: `@tsql/rest` reaches it from a query string
 * and `@tsql/query` from an object, and everything after it -- planning, SQL, `set_config`, error
 * mapping -- is this package. So the two front-ends agreeing *here* is what makes them answer the
 * same thing, and neither has to be run against the other to show it: each is checked against the
 * expectations in `parsed.fixtures.json`.
 *
 * `embeds` is a Map, keyed by a dotted alias path; its order is not part of the meaning, so it is
 * sorted. The JSON round trip drops `undefined` properties on both sides, rather than leaving a
 * `limit: undefined` to differ from a missing one.
 */
export const normalizeParsed = (q: ParsedQuery): unknown =>
  JSON.parse(
    JSON.stringify({
      select: q.select,
      root: q.root,
      embeds: Object.fromEntries([...q.embeds].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      onConflict: q.onConflict,
      columns: q.columns,
    }),
  );

/** One case of the boundary: the query string `@tsql/rest` reads, and what both must produce. */
export interface ParsedCase {
  readonly qs: string;
  readonly parsed: unknown;
}
