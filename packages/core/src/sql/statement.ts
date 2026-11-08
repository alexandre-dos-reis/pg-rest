import { literal } from "../quote";
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
  /**
   * An aggregate over the rows `_t` giving the body as text, in place of JSON (CSV, GeoJSON, a media type
   * handler: the caller knows which). Ignored when the shape is `none`.
   */
  readonly render?: string | undefined;
  /** Settings to read once the statement is done: they come back as `setting_<n>`, in this order. */
  readonly read?: ReadonlyArray<string> | undefined;
  /**
   * `source` flags inserted rows in a `pgrst_inserted` column (merge-duplicates upsert). These are the
   * source's other columns; `none_inserted` says that rows were returned but none was inserted.
   */
  readonly upsertColumns?: ReadonlyArray<string> | undefined;
}

const bodyExpr = (shape: BodyShape, strip: boolean, render?: string): string => {
  if (render && shape !== "none") return render;
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
 * `page_total`, `body`, `total_result_set`, one `setting_<n>` for each name of `read`, and `none_inserted`.
 *
 * The settings of `read` are read at the end so that functions (RPC, triggers) can answer by calling
 * `set_config`.
 */
export const buildStatement = (o: StatementOptions): string => {
  const up = o.upsertColumns;
  const ctes = [
    ...(o.source && up
      ? [`pgrst_ins AS (${o.source})`, `pgrst_source AS (SELECT ${up.join(", ")} FROM pgrst_ins)`]
      : o.source
        ? [`pgrst_source AS (${o.source})`]
        : []),
    `pgrst_body AS (${o.rows})`,
  ];
  return (
    `WITH ${ctes.join(", ")} SELECT ` +
    `count(*)::text AS page_total, ` +
    `${bodyExpr(o.shape, Boolean(o.stripNulls), o.render)} AS body, ` +
    `${o.count ? `(${o.count})::text` : "NULL::text"} AS total_result_set, ` +
    (o.read ?? []).map((name, i) => `nullif(current_setting(${literal(name)}, true), '') AS setting_${i}, `).join("") +
    (up
      ? `(EXISTS (SELECT 1 FROM pgrst_ins) AND NOT EXISTS (SELECT 1 FROM pgrst_ins WHERE pgrst_inserted)) AS none_inserted `
      : `false AS none_inserted `) +
    `FROM pgrst_body AS _t`
  );
};
