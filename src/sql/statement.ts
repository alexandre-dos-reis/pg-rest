/**
 * How the rows produced by the request are turned into a response body.
 * - `array`:       `[{...}, {...}]`
 * - `object`:      first row as an object (singular responses, composite RPC)
 * - `scalar-array`: `[1, 2, 3]` (SETOF scalar)
 * - `scalar`:      a single JSON value (scalar RPC)
 * - `none`:        empty body
 */
export type BodyShape = "array" | "object" | "scalar-array" | "scalar" | "none";

export interface StatementOptions {
  /** Data-modifying statement exposed to later parts as `pgrst_source`. */
  readonly source?: string | undefined;
  /** SELECT producing the rows to aggregate (may read `pgrst_source`). */
  readonly rows: string;
  /** `SELECT count(*) …` for a total count, if requested. */
  readonly count?: string | undefined;
  readonly shape: BodyShape;
  readonly stripNulls?: boolean | undefined;
}

const bodyExpr = (shape: BodyShape, strip: boolean): string => {
  const wrap = (e: string) => (strip ? `json_strip_nulls(${e})` : e);
  switch (shape) {
    case "array":
      return `coalesce(${wrap("json_agg(_t)")}, '[]'::json)::text`;
    case "object":
      return `coalesce((${wrap("json_agg(_t)")} -> 0), 'null'::json)::text`;
    case "scalar-array":
      return `coalesce(json_agg(_t.pgrst_scalar), '[]'::json)::text`;
    case "scalar":
      return `coalesce((json_agg(_t.pgrst_scalar) -> 0)::text, 'null')`;
    case "none":
      return `''::text`;
  }
};

/**
 * The one statement that runs a request. Result columns:
 * `page_total`, `body`, `total_result_set`, `response_headers`, `response_status`.
 *
 * `response.headers` / `response.status` are read at the end so that functions
 * (RPC, triggers) can influence the response by calling `set_config`.
 */
export const buildStatement = (o: StatementOptions): string => {
  const ctes = [
    ...(o.source ? [`pgrst_source AS (${o.source})`] : []),
    `pgrst_body AS (${o.rows})`,
  ];
  return (
    `WITH ${ctes.join(", ")} SELECT ` +
    `count(*)::text AS page_total, ` +
    `${bodyExpr(o.shape, Boolean(o.stripNulls))} AS body, ` +
    `${o.count ? `(${o.count})::text` : "NULL::text"} AS total_result_set, ` +
    `nullif(current_setting('response.headers', true), '') AS response_headers, ` +
    `nullif(current_setting('response.status', true), '') AS response_status ` +
    `FROM pgrst_body AS _t`
  );
};
