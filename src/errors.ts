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
    super(fields.body.message);
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
 * (https://docs.postgrest.org/en/v14/references/errors.html).
 */
const statusFromSqlState = (state: string, role: string, anon: string): number => {
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
export const dbErrorToApiError = (err: DbErrorInfo, role: string, anonymousRole: string): ApiError => {
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
