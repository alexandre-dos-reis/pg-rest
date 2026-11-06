/**
 * Error body, in the exact shape PostgREST returns:
 * `{ code, message, details, hint }`.
 */
export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details: string | null;
  readonly hint: string | null;
}

/**
 * Thrown by the pure parts of the library (parsers, SQL builders). It is
 * converted into an {@link ApiError} at the request boundary.
 */
export class PgRestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string | null = null,
    readonly hint: string | null = null,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "PgRestError";
  }

  get body(): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      hint: this.hint,
    };
  }
}

/**
 * A one-line summary for stack traces and logs. The wire format is `body`, which this never
 * touches: PostgREST clients read `message` from the JSON, while a program that catches the
 * error reads it from `Error.message` and wants the code and hint with it.
 */
const describe = (b: ErrorBody): string =>
  [`${b.code}:`, b.message, b.details ? `(${b.details})` : "", b.hint ? `hint: ${b.hint}` : ""]
    .filter(Boolean)
    .join(" ");

/** An error that has already been mapped to an HTTP response. */
export class ApiError extends Error {
  readonly _tag = "ApiError";
  readonly status: number;
  readonly body: ErrorBody;
  readonly headers: Readonly<Record<string, string>>;
  constructor(fields: {
    readonly status: number;
    readonly body: ErrorBody;
    readonly headers: Readonly<Record<string, string>>;
  }) {
    super(describe(fields.body));
    this.name = "ApiError";
    this.status = fields.status;
    this.body = fields.body;
    this.headers = fields.headers;
  }
}

/** Failure talking to the database, carrying Postgres error fields. */
export interface DbErrorInfo {
  /** SQLSTATE, e.g. "23505", or a custom code such as "PT401" / "PGRST". */
  readonly sqlState: string;
  readonly message: string;
  readonly detail?: string | undefined;
  readonly hint?: string | undefined;
}

/** Normalized error thrown by a {@link DbAdapter}. */
export class DbQueryError extends Error implements DbErrorInfo {
  constructor(
    readonly sqlState: string,
    message: string,
    readonly detail?: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "DbQueryError";
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Recognise a database error thrown by any driver and turn it into a {@link DbQueryError}.
 * Drivers put the SQLSTATE in different places: `code` (node-postgres, postgres.js, PGlite),
 * `errno` (Bun.sql) or `sqlState`. Anything else (connection errors, bugs) is returned unchanged.
 */
export const normalizeDbError = (e: unknown): unknown => {
  if (e instanceof DbQueryError || !e || typeof e !== "object") return e;
  const x = e as Record<string, unknown>;
  for (const key of ["sqlState", "code", "errno"] as const) {
    const v = x[key];
    if (typeof v === "string" && SQLSTATE.test(v)) {
      return new DbQueryError(
        v,
        String(x["message"] ?? ""),
        typeof x["detail"] === "string" ? x["detail"] : undefined,
        typeof x["hint"] === "string" ? x["hint"] : undefined,
      );
    }
  }
  return e;
};

/**
 * SQLSTATE → HTTP status, following the PostgREST 16 table
 * (https://docs.postgrest.org/en/v16/references/errors.html).
 */
const statusFromSqlState = (state: string, role: string | undefined, anon: string | undefined): number => {
  if (/^PT\d{3}$/.test(state)) return Number(state.slice(2));
  switch (state) {
    case "23503":
    case "23505":
      return 409;
    case "25006":
      return 405;
    case "42883":
    case "42P01":
      return 404;
    case "42P17":
      return 500;
    case "42501":
      return role === anon ? 401 : 403;
    case "P0001":
      return 400;
    case "53400":
      return 500;
  }
  switch (state.slice(0, 2)) {
    case "08":
    case "53":
      return 503;
    case "0L":
    case "0P":
    case "28":
      return 403;
    case "09":
    case "25":
    case "2D":
    case "38":
    case "39":
    case "3B":
    case "40":
    case "54":
    case "55":
    case "57":
    case "58":
    case "F0":
    case "HV":
    case "P0":
    case "XX":
      return 500;
    default:
      return 400;
  }
};

/**
 * Map a Postgres error to a PostgREST-style API error.
 *
 * Supports PostgREST's custom error conventions:
 * - `RAISE ... USING ERRCODE = 'PTxyz'` → HTTP status xyz
 * - `RAISE SQLSTATE 'PGRST'` with a JSON message/detail
 */
export const dbErrorToApiError = (
  err: DbErrorInfo,
  role: string | undefined,
  anonymousRole: string | undefined,
): ApiError => {
  if (err.sqlState === "PGRST") {
    try {
      const msg = JSON.parse(err.message) as Partial<ErrorBody>;
      const det = err.detail
        ? (JSON.parse(err.detail) as {
            status?: number;
            headers?: Record<string, string>;
          })
        : {};
      return new ApiError({
        status: det.status ?? 500,
        headers: det.headers ?? {},
        body: {
          code: msg.code ?? "PGRST",
          message: msg.message ?? "",
          details: msg.details ?? null,
          hint: msg.hint ?? null,
        },
      });
    } catch {
      return new ApiError({
        status: 500,
        headers: {},
        body: {
          code: "PGRST121",
          message: "Could not parse JSON in the RAISE error",
          details: err.message,
          hint: null,
        },
      });
    }
  }
  return new ApiError({
    status: statusFromSqlState(err.sqlState, role, anonymousRole),
    headers: {},
    body: {
      code: err.sqlState,
      message: err.message,
      details: err.detail ?? null,
      hint: err.hint ?? null,
    },
  });
};

// ---------------------------------------------------------------------------
// error kinds
// ---------------------------------------------------------------------------

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
