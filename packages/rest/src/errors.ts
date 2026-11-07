import { DbQueryError, type DbErrorInfo, EngineError, type Reason, isConnectionError } from "@tsql/core/errors";

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

/** What a reason answers with over HTTP: PostgREST's status and code. */
const REASONS: Readonly<Record<Reason, readonly [status: number, code: string]>> = {
  invalid_input: [400, "PGRST100"],
  invalid_setting: [500, "PGRST100"],
  invalid_body: [400, "PGRST102"],
  not_embedded: [400, "PGRST108"],
  limit_offset_on_put: [400, "PGRST114"],
  payload_key_mismatch: [400, "PGRST115"],
  invalid_related_order: [400, "PGRST118"],
  invalid_embed_filter: [400, "PGRST120"],
  too_many_affected: [400, "PGRST124"],
  not_implemented: [400, "PGRST127"],
  max_affected_unsupported: [400, "PGRST128"],
  no_relationship: [400, "PGRST200"],
  ambiguous_relationship: [300, "PGRST201"],
  unknown_column: [400, "PGRST204"],
  undefined_column: [400, "42703"],
  anonymous_disabled: [401, "PGRST302"],
  function_not_found: [404, "PGRST202"],
  ambiguous_function: [300, "PGRST203"],
  table_not_found: [404, "PGRST205"],
  rpc_method_not_allowed: [405, "PGRST101"],
  put_requires_pk: [405, "PGRST105"],
  schema_not_exposed: [406, "PGRST106"],
  not_single_row: [406, "PGRST116"],
  range_not_satisfiable: [416, "PGRST103"],
  invalid_response_headers: [500, "PGRST111"],
  invalid_response_status: [500, "PGRST112"],
};

/** An engine error as the PostgREST error it answers with. */
const fromEngineError = (e: EngineError): ApiError => {
  const [status, code] = REASONS[e.reason];
  const headers: Record<string, string> = {};
  if (e.data.total !== undefined) headers["Content-Range"] = `*/${e.data.total}`;
  if (e.data.applied) headers["Preference-Applied"] = e.data.applied;
  return new ApiError({ status, body: { code, message: e.message, details: e.details, hint: e.hint }, headers });
};

/** Map anything thrown while handling a request to an {@link ApiError}. */
export const toApiError = (e: unknown, role: string | undefined, anonymousRole: string | undefined): ApiError => {
  if (e instanceof ApiError) return e;
  if (e instanceof PgRestError) return new ApiError({ status: e.status, body: e.body, headers: e.headers });
  if (e instanceof EngineError) return fromEngineError(e);
  if (e instanceof DbQueryError) return dbErrorToApiError(e, role, anonymousRole);
  if (isConnectionError(e)) {
    return new ApiError({
      status: 503,
      headers: {},
      body: {
        code: "PGRST001",
        message: "Database connection failed",
        details: e instanceof Error ? e.message : null,
        hint: null,
      },
    });
  }
  return new ApiError({
    status: 500,
    headers: {},
    body: { code: "PGRSTX00", message: "Internal error", details: null, hint: null },
  });
};
