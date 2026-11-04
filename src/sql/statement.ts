/**
 * How the rows produced by the request are turned into a response body.
 * - `array`:       `[{...}, {...}]`
 * - `object`:      first row as an object (singular responses, composite RPC)
 * - `scalar-array`: `[1, 2, 3]` (SETOF scalar)
 * - `scalar`:      a single JSON value (scalar RPC)
 * - `none`:        empty body
 */
import type { MediaChoice } from "../parse/request";

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
  /** Render the body as CSV, the way PostgREST does: header from the first row, then PostgreSQL's record text. */
  readonly csv?: boolean | undefined;
  /** Render the rows as a GeoJSON FeatureCollection, the way PostgREST does (needs PostGIS). */
  readonly geojson?: boolean | undefined;
  /** Render the body with a custom media type handler; binary bodies come back hex-encoded. */
  readonly handler?: MediaChoice | undefined;
  /**
   * `source` flags inserted rows in a `pgrst_inserted` column (merge-duplicates upsert). These are the
   * source's other columns; the status becomes 200 when rows were returned but none was inserted.
   */
  readonly upsertColumns?: ReadonlyArray<string> | undefined;
}

const CSV_BODY =
  `coalesce((SELECT string_agg(k, ',') FROM (SELECT json_object_keys(r)::text AS k FROM ` +
  `(SELECT row_to_json(hh) AS r FROM pgrst_body AS hh LIMIT 1) s) a), '') || E'\\n' || ` +
  `coalesce(string_agg(substring(_t::text, 2, length(_t::text) - 2), E'\\n'), '')`;

const handlerBody = (h: MediaChoice): string => {
  if (h.aggregate) {
    const call = `${h.aggregate}(${h.rowType ? `ROW(_t.*)::${h.rowType}` : "_t"})`;
    return h.bytea ? `coalesce(encode(${call}::bytea, 'hex'), '')` : `coalesce(${call}::text, '')`;
  }
  return h.bytea
    ? `coalesce(encode((array_agg(_t.pgrst_scalar::bytea))[1], 'hex'), '')`
    : `coalesce((array_agg(_t.pgrst_scalar::text))[1], '')`;
};

const GEOJSON_BODY =
  `json_build_object('type', 'FeatureCollection', 'features', ` +
  `coalesce(json_agg(ST_AsGeoJSON(_t)::json), '[]'::json))::text`;

const bodyExpr = (shape: BodyShape, strip: boolean, csv: boolean, handler?: MediaChoice, geojson?: boolean): string => {
  if (geojson && shape !== "none") return GEOJSON_BODY;
  if (handler && shape !== "none") return handlerBody(handler);
  if (csv && shape !== "none") return CSV_BODY;
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
    `${bodyExpr(o.shape, Boolean(o.stripNulls), Boolean(o.csv), o.handler, o.geojson)} AS body, ` +
    `${o.count ? `(${o.count})::text` : "NULL::text"} AS total_result_set, ` +
    `nullif(current_setting('response.headers', true), '') AS response_headers, ` +
    (up
      ? `coalesce(nullif(current_setting('response.status', true), ''), CASE WHEN EXISTS (SELECT 1 FROM pgrst_ins) AND NOT EXISTS (SELECT 1 FROM pgrst_ins WHERE pgrst_inserted) THEN '200' END)`
      : `nullif(current_setting('response.status', true), '')`) +
    ` AS response_status ` +
    `FROM pgrst_body AS _t`
  );
};
