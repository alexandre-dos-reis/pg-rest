// What went wrong, as a closed set of strings: `QueryError.kind`. This is where an engine error and a
// database error become one. `no_context` and `rolled_back` name situations that only exist for
// `setContextQuery()` and `transaction()`, which create them directly.
import { DbQueryError, EngineError, type Reason, isConnectionError } from "@tsql/core/errors";

/**
 * What went wrong, as one of a closed set of strings -- the thing a program switches on.
 *
 * Every error, from any layer, lands on exactly one of these, chosen so each one calls for a
 * different reaction rather than merely a different wording. A `switch` on `kind` with a `default`
 * keeps compiling if a later version maps a new case.
 */
export type ErrorKind =
  /** The query itself does not make sense: unknown operator, unparseable `select`, bad `order`, a filter on something that is not embedded. Fix the call. */
  | "invalid_query"
  /** The rows or the `set` do not fit the table: a column that does not exist, keys that differ between rows, an empty payload. */
  | "invalid_payload"
  /** Nothing in the database answers to that name -- table, view or function. Often a typo (read the `hint`) or a schema generated late. */
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
  /** Your own `RAISE` in SQL: a business error, with the message you wrote. */
  | "raised"
  /** The feature is not implemented, or not over this call: related ordering, aggregates in a spread. */
  | "unsupported"
  /** The database could not be reached, is out of connections, or timed out. Retrying may work; nothing else here will. */
  | "unavailable"
  /** The context source of a bound query returned nothing -- the store it reads was never entered. A wiring bug, not a request problem. */
  | "no_context"
  /** A transaction scope will not commit: `rollback()` was called, or a query in it already failed. Everything it did is undone. */
  | "rolled_back"
  /** Anything left: a bug, or an error that was not foreseen. The original is under `cause`. */
  | "internal";

/** What the engine refused, as a kind. */
const REASON_KINDS: Readonly<Record<Reason, ErrorKind>> = {
  invalid_input: "invalid_query",
  invalid_setting: "invalid_query",
  invalid_body: "invalid_payload",
  not_embedded: "invalid_query",
  limit_offset_on_put: "invalid_query",
  payload_key_mismatch: "invalid_payload",
  invalid_related_order: "invalid_query",
  invalid_embed_filter: "invalid_query",
  too_many_affected: "too_many_affected",
  not_implemented: "unsupported",
  max_affected_unsupported: "invalid_query",
  no_relationship: "invalid_embed",
  ambiguous_relationship: "invalid_embed",
  unknown_column: "invalid_payload",
  undefined_column: "undefined_object",
  anonymous_disabled: "unauthenticated",
  function_not_found: "undefined_object",
  ambiguous_function: "invalid_query",
  table_not_found: "undefined_object",
  put_requires_pk: "invalid_query",
  schema_not_exposed: "invalid_query",
  not_single_row: "not_single_row",
  range_not_satisfiable: "invalid_query",
};

/** The SQLSTATEs a caller is likely to act on. */
const STATE_KINDS: Readonly<Record<string, ErrorKind>> = {
  "23502": "invalid_data",
  "23503": "conflict",
  "23505": "conflict",
  "23514": "invalid_data",
  "25006": "unsupported",
  "42703": "undefined_object",
  "42883": "undefined_object",
  "42P01": "undefined_object",
  "42P17": "internal",
  P0001: "raised",
};

/** SQLSTATE class (the first two characters) -> kind, for the codes not named one by one. */
const CLASS_KINDS: Readonly<Record<string, ErrorKind>> = {
  "08": "unavailable",
  "09": "internal",
  "0A": "unsupported",
  "0L": "forbidden",
  "0P": "forbidden",
  "22": "invalid_data",
  "23": "invalid_data",
  "25": "internal",
  "28": "unauthenticated",
  "2D": "internal",
  "38": "internal",
  "39": "internal",
  "3B": "internal",
  "40": "internal",
  "53": "unavailable",
  "54": "internal",
  "55": "internal",
  "57": "unavailable",
  "58": "unavailable",
  F0: "internal",
  HV: "internal",
  P0: "internal",
  XX: "internal",
};

/** The other classes PostgreSQL defines: an error in any class outside these was raised with a code of its own. */
const STANDARD_CLASSES: ReadonlySet<string> = new Set(
  "00 01 02 03 0B 0F 0Z 20 21 24 26 27 2B 2F 34 3D 3F 42 44 72".split(" "),
);

const stateKind = (state: string, role: string | undefined, anonymousRole: string | undefined): ErrorKind => {
  const named = STATE_KINDS[state];
  if (named) return named;
  // no privilege: for nobody in particular it is a missing login, for a role it is a refusal
  if (state === "42501") return role === anonymousRole ? "unauthenticated" : "forbidden";
  const klass = state.slice(0, 2);
  const byClass = CLASS_KINDS[klass];
  if (byClass) return byClass;
  // `RAISE ... USING ERRCODE = '...'` with a code of your own
  return STANDARD_CLASSES.has(klass) ? "invalid_query" : "raised";
};

const KIND_SUMMARIES: Readonly<Record<ErrorKind, string>> = {
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

/** A few words naming an {@link ErrorKind}, for a log line or a message a person reads. */
export const describeErrorKind = (kind: ErrorKind): string => KIND_SUMMARIES[kind];

/** A failure as `@tsql/query` reports it: what the engine says, with nothing of the transport in it. */
export interface Failure {
  readonly kind: ErrorKind;
  readonly message: string;
  readonly details: string | null;
  readonly hint: string | null;
  /** The database's SQLSTATE, when the failure came from the database. */
  readonly sqlState: string | undefined;
  /** True when it was not one of the errors raised on purpose: the original is worth keeping. */
  readonly unexpected: boolean;
}

/** Map anything the engine threw to a {@link Failure}. */
export const describeFailure = (e: unknown, role: string | undefined, anonymousRole: string | undefined): Failure => {
  if (e instanceof EngineError) {
    return {
      kind: REASON_KINDS[e.reason],
      message: e.message,
      details: e.details,
      hint: e.hint,
      sqlState: undefined,
      unexpected: false,
    };
  }
  if (e instanceof DbQueryError) {
    const kind = stateKind(e.sqlState, role, anonymousRole);
    return {
      kind,
      message: e.message,
      details: e.detail ?? null,
      hint: e.hint ?? null,
      sqlState: e.sqlState,
      unexpected: kind === "internal",
    };
  }
  if (isConnectionError(e)) {
    return {
      kind: "unavailable",
      message: "Database connection failed",
      details: e instanceof Error ? e.message : null,
      hint: null,
      sqlState: undefined,
      unexpected: true,
    };
  }
  return {
    kind: "internal",
    message: "Internal error",
    details: null,
    hint: null,
    sqlState: undefined,
    unexpected: true,
  };
};
