// What a `QueryError` says went wrong, as a closed set of strings: `@tsql/query`'s half of an error.
// The body stays PostgREST's (see `@tsql/core/errors`); this classifies it. Two of the kinds, `no_context` and
// `rolled_back`, name situations that only exist for `setContextQuery()` and `transaction()`.

/**
 * What went wrong, as one of a closed set of strings -- the thing a program switches on.
 *
 * The wire body stays PostgREST's (`code` is a `PGRSTxxx` code or a SQLSTATE, and there are
 * dozens), which is precise but not something code can branch on without a table of codes.
 * `kind` is that table: every error, from any layer, lands on exactly one of these, chosen so
 * each one calls for a different reaction rather than merely a different wording.
 *
 * The mapping is a widening, never a narrowing: `code` is still there for the exact reason, and a
 * `switch` on `kind` with a `default` keeps compiling if a later version maps a new code.
 */
export type QueryErrorKind =
  /** The query itself does not make sense: unknown operator, unparseable `select`, bad `order`, a filter on something that is not embedded. Fix the call. */
  | "invalid_query"
  /** The rows or the `set` do not fit the table: a column that does not exist, keys that differ between rows, an empty payload. */
  | "invalid_payload"
  /** Nothing in the database answers to that name -- table, view or function. Often a typo (read the `hint`) or a schema reloaded late. */
  | "undefined_object"
  /** The embedding could not be resolved: no relationship between the two resources, or more than one, which needs a `hint`. */
  | "invalid_embed"
  /** `single` matched something other than exactly one row -- the usual "not found", and also "found several". */
  | "not_single_row"
  /** The write would have touched more rows than `maxAffected`, so it was rolled back. */
  | "too_many_affected"
  /** Nobody is authenticated: no role in the context, or anonymous access is disabled. */
  | "unauthenticated"
  /** The role exists but lacks the privilege; RLS hiding rows shows up as empty data, not here. */
  | "forbidden"
  /** A unique or foreign key constraint rejected the row: it already exists, or what it points at does not. */
  | "conflict"
  /** The database refused the values themselves: a check constraint, a NOT NULL, a failed cast, a bad datetime. */
  | "invalid_data"
  /** Your own `RAISE` in SQL (`P0001`, `PTxyz`, `PGRST`): a business error, with the message you wrote. */
  | "raised"
  /** The feature is not implemented, or not over this call: related ordering, aggregates in a spread, a media type `query()` cannot do. */
  | "unsupported"
  /** The database could not be reached, is out of connections, or timed out. Retrying may work; nothing else here will. */
  | "unavailable"
  /** The context source of a bound query returned nothing -- the store it reads was never entered. A wiring bug, not a request problem. */
  | "no_context"
  /** A transaction scope will not commit: `rollback()` was called, or a query in it already failed. Everything it did is undone. */
  | "rolled_back"
  /** Anything left: a bug in pg-rest, or an error it did not foresee. The original is under `cause`. */
  | "internal";

/** The codes whose kind is not implied by their status. */
const CODE_KINDS: Readonly<Record<string, QueryErrorKind>> = {
  // PGRST1xx -- the request
  PGRST100: "invalid_query",
  PGRST101: "invalid_query",
  PGRST102: "invalid_payload",
  PGRST103: "invalid_query",
  PGRST105: "invalid_query",
  PGRST106: "invalid_query",
  PGRST107: "unsupported",
  PGRST108: "invalid_query",
  PGRST111: "internal",
  PGRST112: "internal",
  PGRST114: "invalid_query",
  PGRST115: "invalid_payload",
  PGRST116: "not_single_row",
  PGRST117: "unsupported",
  PGRST118: "invalid_query",
  PGRST120: "invalid_query",
  PGRST121: "internal",
  PGRST122: "invalid_query",
  PGRST124: "too_many_affected",
  PGRST125: "invalid_query",
  PGRST126: "unsupported",
  PGRST127: "unsupported",
  PGRST128: "invalid_query",
  // PGRST2xx -- the schema cache
  PGRST200: "invalid_embed",
  PGRST201: "invalid_embed",
  PGRST202: "undefined_object",
  PGRST203: "invalid_query",
  PGRST204: "invalid_payload",
  PGRST205: "undefined_object",
  // PGRST3xx -- who is asking
  PGRST302: "unauthenticated",
  // ours
  PGRST001: "unavailable",
  PGRSTX00: "internal",
  PGRSTX01: "no_context",
  PGRSTX02: "rolled_back",
  PGRSTX03: "rolled_back",
  // SQLSTATEs a caller is likely to act on
  "23502": "invalid_data",
  "23503": "conflict",
  "23505": "conflict",
  "23514": "invalid_data",
  "42703": "undefined_object",
  "42883": "undefined_object",
  P0001: "raised",
  "42P01": "undefined_object",
};

/** SQLSTATE class (the first two characters) → kind, for the codes not named one by one. */
const CLASS_KINDS: Readonly<Record<string, QueryErrorKind>> = {
  "08": "unavailable",
  "0A": "unsupported",
  "0L": "forbidden",
  "0P": "forbidden",
  "22": "invalid_data",
  "23": "invalid_data",
  "28": "unauthenticated",
  "53": "unavailable",
  "57": "unavailable",
  "58": "unavailable",
};

/**
 * Classify an error body: the code when it says enough, its SQLSTATE class next, and the HTTP
 * status last -- which is what makes an unmapped code land somewhere sensible rather than on
 * `"internal"`.
 */
export const errorKind = (status: number, code: string): QueryErrorKind => {
  const named = CODE_KINDS[code];
  if (named) return named;
  // `RAISE ... USING ERRCODE = 'PT404'` and `RAISE SQLSTATE 'PGRST'` are errors someone wrote
  if (code === "PGRST" || /^PT\d{3}$/.test(code)) return "raised";
  const byClass = CLASS_KINDS[code.slice(0, 2)];
  if (byClass) return byClass === "invalid_data" && status === 409 ? "conflict" : byClass;
  switch (status) {
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "undefined_object";
    case 405:
    case 415:
      return "unsupported";
    case 409:
      return "conflict";
    case 503:
      return "unavailable";
  }
  return status >= 500 ? "internal" : "invalid_query";
};

const KIND_SUMMARIES: Readonly<Record<QueryErrorKind, string>> = {
  invalid_query: "the query is not valid",
  invalid_payload: "the payload does not fit the table",
  undefined_object: "no such table, view or function",
  invalid_embed: "the embedded resource could not be resolved",
  not_single_row: "`single` matched other than exactly one row",
  too_many_affected: "the write would have affected more rows than allowed",
  unauthenticated: "nobody is authenticated",
  forbidden: "the role lacks the privilege",
  conflict: "a unique or foreign key constraint rejected the row",
  invalid_data: "the database refused the values",
  raised: "raised by the database",
  unsupported: "not supported",
  unavailable: "the database is unavailable",
  no_context: "the context source returned nothing",
  rolled_back: "the transaction rolled back",
  internal: "unexpected internal error",
};

/** A few words naming a {@link QueryErrorKind}, for a log line or a message a person reads. */
export const describeErrorKind = (kind: QueryErrorKind): string => KIND_SUMMARIES[kind];
