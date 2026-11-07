/**
 * Why the engine refused something, as one id per distinct reason. It is what the engine throws and
 * nothing else: no code, no status. `@tsql/rest` turns a reason into the PostgREST code and HTTP
 * status it answers with, and `@tsql/query` turns it into a `kind`.
 */
export type Reason =
  /** The input does not parse or does not make sense: a bad filter, `select`, `order`, identifier or value. */
  | "invalid_input"
  /** A caller-supplied setting has a name that is not allowed. */
  | "invalid_setting"
  /** The body cannot be written: empty, malformed, keys that differ between rows, no columns. */
  | "invalid_body"
  /** A filter or order names a resource that is not embedded in the `select`. */
  | "not_embedded"
  /** `limit` or `offset` on a `PUT`. */
  | "limit_offset_on_put"
  /** The payload disagrees with the primary key in the URL. */
  | "payload_key_mismatch"
  /** An order by a related table that is not to-one. */
  | "invalid_related_order"
  /** An embedded resource filtered by anything but null / not null. */
  | "invalid_embed_filter"
  /** A write would have affected more rows than allowed. */
  | "too_many_affected"
  /** Something the engine does not implement. */
  | "not_implemented"
  /** `maxAffected` on a function that returns no set. */
  | "max_affected_unsupported"
  /** No relationship between two resources. */
  | "no_relationship"
  /** More than one relationship between two resources. */
  | "ambiguous_relationship"
  /** A column of the payload that the table does not have. */
  | "unknown_column"
  /** A column an ordering needs that is not in the embedded `select`. */
  | "undefined_column"
  /** Anonymous access is disabled and nobody was identified. */
  | "anonymous_disabled"
  /** No function by that name and arguments. */
  | "function_not_found"
  /** More than one function fits. */
  | "ambiguous_function"
  /** No table or view by that name. */
  | "table_not_found"
  /** A function cannot be called that way. */
  | "rpc_method_not_allowed"
  /** An upsert by `PUT` needs the primary key and nothing else as filters. */
  | "put_requires_pk"
  /** A schema that is not one of the exposed ones. */
  | "schema_not_exposed"
  /** `single` matched other than exactly one row. */
  | "not_single_row"
  /** The offset or limit leaves nothing to answer with. */
  | "range_not_satisfiable"
  /** The function's `response.headers` setting is not what it should be. */
  | "invalid_response_headers"
  /** The function's `response.status` setting is not a status. */
  | "invalid_response_status";

/** What a reason may carry besides its text. */
export interface EngineErrorData {
  /** The number of rows there were, for `range_not_satisfiable`. */
  readonly total?: number;
  /** The preferences that were applied before the failure, as the transport reports them. */
  readonly applied?: string;
}

/** Thrown by the engine (parsers, planners, SQL builders). Each consumer maps it to its own error. */
export class EngineError extends Error {
  constructor(
    readonly reason: Reason,
    message: string,
    readonly details: string | null = null,
    readonly hint: string | null = null,
    readonly data: EngineErrorData = {},
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** Failure talking to the database, carrying Postgres error fields. */
export interface DbErrorInfo {
  /** SQLSTATE, e.g. "23505", or a code of your own raised with `RAISE`. */
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

const CONNECTION_ERROR = /^(ERR_POSTGRES_(CONNECTION|AUTH|TLS|IDLE|LIFETIME)|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND)/;

/** True for what a driver throws when the database cannot be reached. */
export const isConnectionError = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && CONNECTION_ERROR.test(code);
};
