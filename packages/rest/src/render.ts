import type { OutputFormat } from "@tsql/core/parse/request";
import type { MediaChoice, Negotiated } from "./request";

// The formats `Accept` can ask for beyond JSON, as SQL. The engine knows none of them: it is given
// the aggregate that turns the rows `_t` into the body text, and `@tsql/rest` decides which one.

/** CSV, the way PostgREST does: the header from the first row, then PostgreSQL's record text. */
const CSV_BODY =
  `coalesce((SELECT string_agg(k, ',') FROM (SELECT json_object_keys(r)::text AS k FROM ` +
  `(SELECT row_to_json(hh) AS r FROM pgrst_body AS hh LIMIT 1) s) a), '') || E'\\n' || ` +
  `coalesce(string_agg(substring(_t::text, 2, length(_t::text) - 2), E'\\n'), '')`;

/** A GeoJSON FeatureCollection, the way PostgREST does (needs PostGIS). */
const GEOJSON_BODY =
  `json_build_object('type', 'FeatureCollection', 'features', ` +
  `coalesce(json_agg(ST_AsGeoJSON(_t)::json), '[]'::json))::text`;

/** A custom media type handler; a binary body comes back hex-encoded. */
const handlerBody = (h: MediaChoice): string => {
  if (h.aggregate) {
    const call = `${h.aggregate}(${h.rowType ? `ROW(_t.*)::${h.rowType}` : "_t"})`;
    return h.bytea ? `coalesce(encode(${call}::bytea, 'hex'), '')` : `coalesce(${call}::text, '')`;
  }
  return h.bytea
    ? `coalesce(encode((array_agg(_t.pgrst_scalar::bytea))[1], 'hex'), '')`
    : `coalesce((array_agg(_t.pgrst_scalar::text))[1], '')`;
};

/** What the engine is told about a negotiated format. */
export const toEngineFormat = (format: Negotiated): OutputFormat => {
  switch (format.kind) {
    case "json":
    case "object":
      return format;
    case "csv":
      return { kind: "rendered", sql: CSV_BODY, voidRows: false };
    case "geojson":
      return { kind: "rendered", sql: GEOJSON_BODY, voidRows: true };
    case "handler":
      return { kind: "rendered", sql: handlerBody(format.choice), voidRows: false };
    case "plan":
      return toEngineFormat(format.inner);
    case "openapi":
      // the root is answered before any statement is planned
      return { kind: "json", stripNulls: false };
  }
};
