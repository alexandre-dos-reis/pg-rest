// What the engine takes from a call, whatever carried it: what it does, the preferences, the output
// format. Reading them out of HTTP (`Prefer`, `Accept`, `Range`) is `@tsql/rest`'s job;
// `@tsql/query` builds them from an object.

/** What a call does to a table: read it, insert into it, update, delete from it, or upsert one row by key (`put`). */
export type Operation = "read" | "insert" | "update" | "delete" | "put";

export interface Preferences {
  readonly return?: "minimal" | "headers-only" | "representation";
  readonly count?: "exact" | "planned" | "estimated";
  readonly resolution?: "merge-duplicates" | "ignore-duplicates";
  readonly missing?: "default" | "null";
  readonly handling?: "strict" | "lenient";
  readonly timezone?: string;
  readonly maxAffected?: number;
}

/**
 * How the body of a response is rendered. JSON is the engine's own (`json_agg`, with `json_strip_nulls`
 * for `stripNulls`, and the first row only for `object`). Anything else (CSV, GeoJSON, a media type
 * handler: what `Accept` can ask for over HTTP) is `rendered` by SQL that the caller supplies, so the engine
 * knows none of those formats.
 */
export type OutputFormat =
  | { readonly kind: "json"; readonly stripNulls: boolean }
  | { readonly kind: "object"; readonly stripNulls: boolean }
  | {
      readonly kind: "rendered";
      /** An aggregate over the rows `_t` that gives the body as text. */
      readonly sql: string;
      /** A function returning nothing still has rows to render (GeoJSON), instead of an empty body. */
      readonly voidRows: boolean;
    };
