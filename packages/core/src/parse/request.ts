// What the engine takes from a request, whatever carried it: the method, the preferences, the output
// format. Reading them out of HTTP headers (`Prefer`, `Accept`, `Range`) is `@tsql/rest`'s job;
// `@tsql/query` builds them from an object.

export type Method = "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE" | "OPTIONS";

export interface Preferences {
  readonly return?: "minimal" | "headers-only" | "representation";
  readonly count?: "exact" | "planned" | "estimated";
  readonly resolution?: "merge-duplicates" | "ignore-duplicates";
  readonly missing?: "default" | "null";
  readonly handling?: "strict" | "lenient";
  readonly tx?: "commit" | "rollback";
  readonly timezone?: string;
  readonly maxAffected?: number;
  /** Preferences that were present but not understood. */
  readonly invalid: ReadonlyArray<string>;
}

/** A custom media type the target can answer with (see `@tsql/rest`). */
export interface MediaChoice {
  readonly mediaType: string;
  /** `Content-Type` of the response. */
  readonly contentType: string;
  /** The body is binary (a `bytea` domain). */
  readonly bytea: boolean;
  /** Aggregate that renders the rows (`"schema"."media/type"(…)`), or `undefined` when the body is the scalar result itself. */
  readonly aggregate?: string;
  /** Cast the row to this table type before aggregating (the aggregate takes a table row, not `anyelement`). */
  readonly rowType?: string;
}

export type OutputFormat =
  | { readonly kind: "handler"; readonly choice: MediaChoice }
  | { readonly kind: "json"; readonly stripNulls: boolean }
  | { readonly kind: "object"; readonly stripNulls: boolean }
  | { readonly kind: "csv" }
  /** `application/geo+json`: a GeoJSON FeatureCollection built by PostGIS's `ST_AsGeoJSON(record)`. */
  | { readonly kind: "geojson" }
  | { readonly kind: "openapi" }
  /** `application/vnd.pgrst.plan`: answer with the EXPLAIN of the query that `inner` describes. */
  | {
      readonly kind: "plan";
      readonly format: "json" | "text";
      readonly forType: string;
      readonly options: ReadonlyArray<string>;
      readonly inner: OutputFormat;
    };
