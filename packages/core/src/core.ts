import type { DbAdapter, DbSession } from "@tsql/adapters";
import { DbQueryError, EngineError } from "./errors";
import type { ParsedQuery } from "./parse/filter";
import { OPERATORS_ORDER } from "./parse/syntax";
import { type SqlOperation, type SqlOutputFormat, type SqlPreferences } from "./parse/sql-options";
import { literal, quoteIdent } from "./quote";
import { getRelation, type Relation, type SchemaCache } from "./schema";
import { buildRead } from "./sql/read";
import { type BodyType, buildRpc, isSingleUnnamedParam, resolveFunction, type RpcCall } from "./sql/rpc";
import { buildStatement, type BodyShape } from "./sql/statement";
import { type Values, bindFrom, inlined } from "./sql/values";
import { buildDelete, buildInsert, upsertColumns, buildUpdate, type JsonObject, type Returning } from "./sql/write";
import { ALIAS, ROOT_ALIAS } from "./constants";

/** Who is making the call, as far as the database is concerned. */
export interface SqlRequestContext {
  /** Database role to run the call as. Defaults to the anonymous role. */
  readonly role?: string | undefined;
  /**
   * Claims exposed to SQL as `current_setting('request.jwt.claims')`.
   * This is what RLS policies read, e.g. `{ sub: "user-123" }`.
   * No signature is involved: you decide who the user is.
   */
  readonly claims?: Readonly<Record<string, unknown>> | undefined;
  /** Extra settings, set with `set_config(name, value, true)`. Names need a dot: `app.tenant_id`. */
  readonly settings?: Readonly<Record<string, string>> | undefined;
}

export interface CoreConfig {
  readonly schemas: ReadonlyArray<string>;
  /** Role for calls without one; `undefined` refuses anonymous access. */
  readonly anonymousRole: string | undefined;
  readonly maxRows?: number | undefined;
  readonly extraSearchPath: ReadonlyArray<string>;
}

export interface SqlEnv {
  readonly db: DbAdapter;
  readonly config: CoreConfig;
  readonly cache: SchemaCache;
  /**
   * A transaction already open, when the call runs inside a scope (`transaction()`): statements go
   * to it instead of to a transaction of their own, and the boundary belongs to the scope.
   */
  readonly session?: DbSession | undefined;
}

/**
 * What a transport adds to one call, and that the engine does not interpret: settings to `set_config`
 * after the identity, and something to run in the transaction before the statement. The `request.*`
 * settings and `preRequest` are built by the packages (`@tsql/rest` from the HTTP request, `@tsql/query`
 * from its own options); the engine only issues them, in the transaction, in this order.
 */
export interface SqlCall {
  /** Transaction-local settings (`set_config(name, value, true)`), issued with the ones for the statement. */
  readonly settings?: ReadonlyArray<readonly [string, string]> | undefined;
  /** Run in the call's transaction after the settings and before the statement. A throw ends the call. */
  readonly before?: ((session: DbSession) => Promise<void>) | undefined;
}

/** Who the database will see for a call: the role (or the anonymous one) and the claims. */
export const identityOf = (env: SqlEnv, ctx: SqlRequestContext): { role: string; claims: Record<string, unknown> } => {
  const role = ctx.role ?? env.config.anonymousRole!;
  return { role, claims: { role, ...(ctx.claims ?? {}) } };
};

/** What a call's parameters turn into, once they are read: see {@link SqlQueryParams.parse}. */
export interface SqlParseOptions {
  /** Leave out the parameters this says yes to (a bare `?a` a function reads as an argument). */
  readonly skip?: ((key: string, value: string) => boolean) | undefined;
  /** Parameters this says no to are not filters (on a GET, the ones that name function arguments). */
  readonly allowFilterKey?: ((key: string) => boolean) | undefined;
}

/**
 * The parameters of a call, plus the way to read them. The engine knows no syntax: `parse` gives
 * it the {@link ParsedQuery} -- `@tsql/rest` parses the query string, `@tsql/query` builds it from its
 * object. `params` and `bare` are only what a GET on a function reads its arguments from.
 */
export interface SqlQueryParams {
  readonly params: ReadonlyArray<readonly [string, string]>;
  readonly bare: ReadonlySet<string>;
  readonly parse: (options?: SqlParseOptions) => ParsedQuery;
  /**
   * Pass the values of the filters to the driver as parameters instead of writing them into the SQL.
   * The text of the statement then depends on the shape of the query only, which is what lets the
   * driver and the server reuse it. `@tsql/query` does; HTTP keeps the literals it always had.
   */
  readonly bind?: boolean | undefined;
  /**
   * Settings (`current_setting(name, true)`) to read once the statement is done, so that a function that
   * `set_config`ed one can be heard: they come back, in this order, as {@link Result.settings}. The
   * engine does not say what they mean. `@tsql/rest` reads the two PostgREST's functions answer with.
   */
  readonly read?: ReadonlyArray<string> | undefined;
  /**
   * `SET` clauses already compiled to SQL, for an update: the expressions of `query()`'s `set`
   * (`sql/expression.ts`). Only `query()` fills it; a PATCH over HTTP is PostgREST's, a JSON body.
   */
  readonly setClauses?: ReadonlyArray<string> | undefined;
}

/** Where the values of the filters go: into the SQL, or into parameters numbered after `taken` others. */
const valuesFor = (qp: SqlQueryParams, taken: number): Values => (qp.bind ? bindFrom(taken) : inlined);

/** Statement options that depend on the output format. */
const formatOptions = (format: SqlOutputFormat, qp: SqlQueryParams) => ({
  render: format.kind === "rendered" ? format.sql : undefined,
  read: qp.read,
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The schema a call runs against: the one it asks for, if exposed, else the default one. */
export const useSchema = (env: SqlEnv, wanted: string | null | undefined): string => {
  const name = wanted?.trim();
  if (!name) return env.config.schemas[0]!;
  if (!env.config.schemas.includes(name)) {
    throw new EngineError(
      "schema_not_exposed",
      `Invalid schema: ${name}`,
      null,
      `Only the following schemas are exposed: ${env.config.schemas.join(", ")}`,
    );
  }
  return name;
};

/** Refuse a call that has no role when anonymous access is disabled. */
export const assertRole = (env: SqlEnv, ctx: SqlRequestContext): void => {
  if (!ctx.role && env.config.anonymousRole === undefined) {
    throw new EngineError("anonymous_disabled", "Anonymous access is disabled", null, null);
  }
};

/** Who is asking, as the database reads it. In a scope this half is issued once, on entry. */
const whoEntries = (role: string, claims: Record<string, unknown>): Array<[string, string]> => [
  ["role", role],
  ["request.jwt.claims", JSON.stringify(claims)],
];

/** The caller's own settings, which go last so one of them wins over a setting of ours it names. */
const settingsEntries = (ctx: SqlRequestContext): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(ctx.settings ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_.]+$/.test(k)) {
      throw new EngineError(
        "invalid_setting",
        `Invalid setting name "${k}"`,
        null,
        "Custom settings need a prefix, e.g. app.tenant_id",
      );
    }
    out.push([k, v]);
  }
  return out;
};

/**
 * The `set_config(..., true)` one call needs. `"statement"` is the half that says where the
 * statement runs -- the schema, the settings SQL reads, the time zone it asked for -- and is all a
 * query inside a transaction scope issues: the identity was set once, on entry, because
 * `set_config` is transaction-local and re-issuing the role halfway through scopes nothing. This
 * half stays per statement, which is what lets two queries of one scope name two schemas.
 */
const ctxEntries = (
  env: SqlEnv,
  ctx: SqlRequestContext,
  role: string,
  claims: Record<string, unknown>,
  call: SqlCall,
  schema: string,
  prefer: SqlPreferences,
  part: "statement" | "both",
): Array<[string, string]> => {
  const where: Array<[string, string]> = call.settings ? call.settings.map(([k, v]) => [k, v]) : [];
  const searchPath = [schema, ...env.config.extraSearchPath].map(quoteIdent).join(", ");
  where.push(["search_path", searchPath]);
  if (prefer.timezone !== undefined) where.push(["timezone", prefer.timezone]);
  if (part === "statement") return where;
  return [...whoEntries(role, claims), ...where, ...settingsEntries(ctx)];
};

const setConfigSql = (entries: ReadonlyArray<readonly [string, string]>): { sql: string; params: string[] } => ({
  sql: `SELECT ${entries.map(([k], i) => `set_config(${literal(k)}, $${i + 1}::text, true)`).join(", ")}`,
  params: entries.map(([, v]) => v),
});

/**
 * What a transaction scope issues on entry: who is asking, for the whole of it. The schema and the
 * `request.*` settings are not here -- every query inside the scope sets its own.
 */
export const transactionSetup = (env: SqlEnv, ctx: SqlRequestContext): { sql: string; params: string[] } => {
  const role = ctx.role ?? env.config.anonymousRole!;
  const claims: Record<string, unknown> = { role, ...(ctx.claims ?? {}) };
  return setConfigSql([...whoEntries(role, claims), ...settingsEntries(ctx)]);
};

class RollbackWith<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}

// ---------------------------------------------------------------------------
// plans
// ---------------------------------------------------------------------------

export interface SqlPlan {
  readonly statement: string;
  readonly params: string[];
  readonly readOnly: boolean;
  readonly source: boolean;
  /** Optional count query results to compute before the main statement. */
  readonly planned?: string | undefined;
  readonly shape: BodyShape;
  /** Write operations report the number of affected rows instead of a range. */
  readonly kind: "read" | "insert" | "update" | "delete" | "put" | "rpc";
  readonly rel?: Relation | undefined;
  readonly rpc?: RpcCall | undefined;
  readonly returning?: Returning | undefined;
  readonly offset: number;
  readonly limit?: number | undefined;
  readonly countInStatement: boolean;
  readonly pagedRead: boolean;
}

const asRows = (body: unknown): JsonObject[] => {
  const isObj = (v: unknown): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(body)) {
    if (!body.every(isObj)) throw new EngineError("invalid_body", "All object keys must match");
    return body as JsonObject[];
  }
  // PostgREST inserts nothing for a scalar payload.
  return isObj(body) ? [body] : [];
};

const effectivePaging = (env: SqlEnv, query: ParsedQuery, range: { offset: number; limit?: number } | undefined) => {
  if (query.root.limit !== undefined && query.root.limit < 0) {
    throw new EngineError(
      "range_not_satisfiable",
      "Requested range not satisfiable",
      "Limit should be greater than or equal to zero.",
      null,
    );
  }
  let limit = query.root.limit ?? range?.limit;
  const offset = query.root.offset ?? range?.offset ?? 0;
  const max = env.config.maxRows;
  if (max !== undefined) limit = limit === undefined ? max : Math.min(limit, max);
  return { limit, offset };
};

// ---------------------------------------------------------------------------
// planning: tables
// ---------------------------------------------------------------------------

export const planTable = (
  env: SqlEnv,
  operation: SqlOperation,
  schema: string,
  name: string,
  qp: SqlQueryParams,
  prefer: SqlPreferences,
  format: SqlOutputFormat,
  range: { offset: number; limit?: number } | undefined,
  body: { kind: string; value: unknown } | undefined,
): SqlPlan => {
  const rel = getRelation(env.cache, schema, name);
  const query = qp.parse();
  const strip = format.kind === "json" || format.kind === "object" ? format.stripNulls : false;
  const singular = format.kind === "object";

  if (operation === "read") {
    const { limit, offset } = effectivePaging(env, query, range);
    const values = valuesFor(qp, 0);
    const read = buildRead({
      cache: env.cache,
      rel,
      from: `${quoteIdent(rel.schema)}.${quoteIdent(rel.name)}`,
      query,
      limit,
      offset,
      values,
    });
    const shape: BodyShape = singular ? "object" : "array";
    const paged = limit !== undefined || offset > 0;
    const needCount = prefer.count === "exact" || prefer.count === "estimated";
    return {
      kind: "read",
      readOnly: true,
      source: false,
      params: values.bound,
      shape,
      rel,
      offset,
      limit,
      pagedRead: paged,
      countInStatement: needCount && paged,
      planned: prefer.count === "planned" || prefer.count === "estimated" ? read.unpaged : undefined,
      statement: buildStatement({
        rows: read.rows,
        count: needCount && paged ? read.count : undefined,
        shape,
        stripNulls: strip,
        ...formatOptions(format, qp),
      }),
    };
  }

  const returning: Returning =
    prefer.return === "representation" ? "representation" : prefer.return === "headers-only" ? "pk" : "minimal";
  const shapeFor = (r: Returning): BodyShape =>
    r === "representation" ? (singular ? "object" : "array") : r === "pk" ? "array" : "none";
  const rowsFor = (r: Returning): { rows: string; shape: BodyShape } => {
    if (r === "representation") {
      // The call's filters selected the rows to write; they must not be applied
      // again to the rows that were written (an UPDATE may no longer match them).
      const resultQuery: ParsedQuery = { ...query, root: { ...query.root, filters: [], presence: [] } };
      const read = buildRead({ cache: env.cache, rel, from: `${ALIAS}_source`, query: resultQuery });
      return { rows: read.rows, shape: shapeFor(r) };
    }
    return { rows: `SELECT * FROM ${ALIAS}_source`, shape: shapeFor(r) };
  };

  const common = {
    rel,
    readOnly: false,
    source: true,
    offset: 0,
    countInStatement: false,
    pagedRead: false,
  } as const;

  if (operation === "insert") {
    if (!body) throw new EngineError("invalid_body", "Empty or invalid json");
    const rows = asRows(body.value);
    const insertSql = buildInsert({
      rel,
      rows,
      columns: query.columns,
      onConflict: query.onConflict,
      resolution: prefer.resolution,
      missingDefault: prefer.missing === "default",
      flagInserted: true,
      returning,
    });
    const { rows: outRows, shape } = rowsFor(returning);
    return {
      ...common,
      kind: "insert",
      returning,
      params: insertSql.includes("$1") ? [JSON.stringify(rows)] : [],
      shape,
      statement: buildStatement({
        source: insertSql,
        rows: outRows,
        shape,
        stripNulls: strip,
        ...formatOptions(format, qp),
        upsertColumns: insertSql.includes(`${ALIAS}_inserted`) ? upsertColumns(rel, returning) : undefined,
      }),
    };
  }

  if (operation === "update") {
    if (!body) throw new EngineError("invalid_body", "Empty or invalid json");
    // PostgREST uses the first element of an array and treats other payloads as "no columns".
    const first = Array.isArray(body.value) ? body.value[0] : body.value;
    const obj: JsonObject =
      first !== null && typeof first === "object" && !Array.isArray(first) ? (first as JsonObject) : {};
    // the JSON body is `$1` when there is one, and the filters' parameters come after it
    const values = valuesFor(qp, Object.keys(obj).length ? 1 : 0);
    const updateSql = buildUpdate({
      rel,
      body: obj as JsonObject,
      clauses: qp.setClauses,
      filters: query.root.filters,
      returning,
      values,
    });
    const { rows: outRows, shape } = rowsFor(returning);
    if (updateSql === null) {
      // Nothing to set: the call matches rows but changes none.
      const emptyShape: BodyShape = returning === "representation" ? (singular ? "object" : "array") : "none";
      return {
        ...common,
        kind: "update",
        returning,
        params: [],
        shape: emptyShape,
        statement: buildStatement({
          source: "SELECT 1 WHERE FALSE",
          rows: `SELECT * FROM ${ALIAS}_source`,
          shape: emptyShape,
          ...formatOptions(format, qp),
        }),
      };
    }
    return {
      ...common,
      kind: "update",
      returning,
      params: [...(Object.keys(obj).length ? [JSON.stringify(obj)] : []), ...values.bound],
      shape,
      statement: buildStatement({
        source: updateSql,
        rows: outRows,
        shape,
        stripNulls: strip,
        ...formatOptions(format, qp),
      }),
    };
  }

  if (operation === "delete") {
    const values = valuesFor(qp, 0);
    const deleteSql = buildDelete({ rel, filters: query.root.filters, returning, values });
    const { rows: outRows, shape } = rowsFor(returning);
    return {
      ...common,
      kind: "delete",
      returning,
      params: values.bound,
      shape,
      statement: buildStatement({
        source: deleteSql,
        rows: outRows,
        shape,
        stripNulls: strip,
        ...formatOptions(format, qp),
      }),
    };
  }

  // PUT: single-row upsert addressed by primary key.
  if (!body) throw new EngineError("invalid_body", "Empty or invalid json");
  const row = body.value;
  if (Array.isArray(row) && !row.every((r) => r !== null && typeof r === "object" && !Array.isArray(r))) {
    throw new EngineError("invalid_body", "All object keys must match");
  }
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new EngineError(
      "invalid_body",
      "Empty or invalid json",
      "The payload of a PUT request must be a JSON object",
    );
  }
  if (query.root.limit !== undefined || query.root.offset !== undefined) {
    throw new EngineError("limit_offset_on_put", "limit/offset querystring parameters are not allowed for PUT");
  }
  if (rel.pk.length === 0) {
    throw new EngineError(
      "put_requires_pk",
      "Filters must include all and only primary key columns with 'eq' operators",
    );
  }
  const keyValues = new Map<string, string>();
  for (const f of query.root.filters) {
    if (
      f.kind === "filter" &&
      f.op === "eq" &&
      !f.negate &&
      !f.quantifier &&
      f.field.json.length === 0 &&
      typeof f.value === "string" &&
      rel.pk.includes(f.field.name)
    ) {
      keyValues.set(f.field.name, f.value);
    } else {
      throw new EngineError(
        "put_requires_pk",
        "Filters must include all and only primary key columns with 'eq' operators",
      );
    }
  }
  if (!rel.pk.every((c) => keyValues.has(c))) {
    throw new EngineError(
      "put_requires_pk",
      "Filters must include all and only primary key columns with 'eq' operators",
    );
  }
  const obj = row as JsonObject;
  for (const c of rel.pk) {
    if (c in obj && String(obj[c]) !== keyValues.get(c)) {
      throw new EngineError("payload_key_mismatch", "Payload values do not match URL in primary key column(s)");
    }
  }
  const full: JsonObject = { ...Object.fromEntries(rel.pk.map((c) => [c, keyValues.get(c)])), ...obj };
  const putSql = buildInsert({ rel, rows: [full], onConflict: rel.pk, resolution: "merge-duplicates", returning });
  const { rows: outRows, shape } = rowsFor(returning);
  return {
    ...common,
    kind: "put",
    returning,
    params: [JSON.stringify([full])],
    shape,
    statement: buildStatement({
      source: putSql,
      rows: outRows,
      shape,
      stripNulls: strip,
      ...formatOptions(format, qp),
    }),
  };
};

// ---------------------------------------------------------------------------
// planning: RPC
// ---------------------------------------------------------------------------

/** A query-string value in the filter syntax (`eq.5`, `not.in.(1,2)`, `like(any).{a*}`), not a plain argument. */
const FILTER_VALUE = new RegExp(`^(not\\.)?(${OPERATORS_ORDER.join("|")})(\\([a-z]+\\))?\\.`);
const looksLikeFilter = (v: string): boolean => FILTER_VALUE.test(v);

/** Query parameters that are never a function argument. */
const RESERVED = new Set(["select", "order", "limit", "offset", "and", "or", "columns", "on_conflict"]);

export const planRpc = (
  env: SqlEnv,
  /** Whether the function may write: it is called in a transaction that is not read only. */
  write: boolean,
  schema: string,
  name: string,
  qp: SqlQueryParams,
  prefer: SqlPreferences,
  format: SqlOutputFormat,
  range: { offset: number; limit?: number } | undefined,
  givenBody: { kind: string; value: unknown; raw?: string; mime?: string } | undefined,
): SqlPlan => {
  let argValues: Record<string, unknown> = {};
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const getArgKeys = new Set<string>();
  const bare = qp.bare;
  // PostgREST reads a JSON body that is neither an object nor an array (`"a"`, `1`, `null`) as an empty array
  const scalar = givenBody?.kind === "json" && (givenBody.value === null || typeof givenBody.value !== "object");
  const body = scalar ? { kind: "json", value: [] as unknown[], raw: "[]" } : givenBody;
  const bodyType: BodyType =
    body?.kind !== "raw"
      ? "json"
      : body.mime === "text/xml"
        ? "xml"
        : body.mime === "application/octet-stream"
          ? "bytea"
          : "text";

  if (write) {
    if (body) {
      const v = body.value;
      if (isObj(v)) argValues = v;
      else {
        if (Array.isArray(v) && v.length > 0) {
          // PostgREST reads the function arguments from the objects of an array body; they must agree on their keys
          const keysOf = (o: unknown) => (isObj(o) ? Object.keys(o).sort().join("\u0000") : undefined);
          const first = keysOf(v[0]);
          if (first === undefined || v.some((o) => keysOf(o) !== first)) {
            throw new EngineError("invalid_body", "All object keys must match", null, null);
          }
          argValues = v[0] as Record<string, unknown>;
        }
      }
    }
  } else {
    // every query parameter that is not a filter, a reserved word or a bare key is an argument
    const lists = new Map<string, string[]>();
    for (const [k, v] of qp.params) {
      if (RESERVED.has(k) || bare.has(k) || looksLikeFilter(v) || k.includes(".")) continue;
      lists.set(k, [...(lists.get(k) ?? []), v]);
    }
    for (const [k, vs] of lists) {
      getArgKeys.add(k);
      argValues[k] = vs.length === 1 ? vs[0] : vs;
    }
  }
  const provided = Object.keys(argValues);
  const fn = resolveFunction(env.cache, schema, name, new Set(provided), body !== undefined && write, write, bodyType);
  // GET: repeated parameters make a list, and a variadic parameter always takes one
  for (const a of fn.args) {
    if (a.variadic && getArgKeys.has(a.name) && !Array.isArray(argValues[a.name]))
      argValues[a.name] = [argValues[a.name]];
  }
  const rawBody = write && body !== undefined && isSingleUnnamedParam(fn, bodyType);
  const call = buildRpc(env.cache, fn, provided, rawBody, bodyType);

  const fnArgNames = new Set(fn.args.map((a) => a.name));
  const query = qp.parse({
    skip: (k, v) => v === "" && bare.has(k),
    // On GET, parameters that name function arguments are not filters.
    allowFilterKey: (k) => write || !fnArgNames.has(k),
  });
  // a single unnamed parameter gets the body as it came, not as it parses
  const argsJson = rawBody ? (body!.raw ?? JSON.stringify(body!.value)) : JSON.stringify(argValues);
  const params = call.usesBody ? [argsJson] : [];
  const strip = format.kind === "json" || format.kind === "object" ? format.stripNulls : false;
  // the function's arguments are `$1` when it has a body, and the filters' parameters come after
  const values = valuesFor(qp, params.length);

  const base = {
    kind: "rpc",
    readOnly: !write,
    source: false,
    rpc: call,
    rel: call.relation,
    params,
    offset: 0,
    countInStatement: false,
    pagedRead: false,
  } as const;

  if (call.shape === "rows" || call.shape === "object") {
    const { limit, offset } = effectivePaging(env, query, range);
    const read = buildRead({
      cache: env.cache,
      rel: call.relation,
      from: `(${call.source})`,
      query,
      limit,
      offset,
      values,
    });
    const shape: BodyShape = call.shape === "object" || format.kind === "object" ? "object" : "array";
    const paged = limit !== undefined || offset > 0;
    const needCount = prefer.count === "exact" || prefer.count === "estimated";
    return {
      ...base,
      params: [...params, ...values.bound],
      offset,
      limit,
      pagedRead: paged,
      countInStatement: needCount && paged,
      planned: prefer.count === "planned" || prefer.count === "estimated" ? read.unpaged : undefined,
      shape,
      statement: buildStatement({
        rows: read.rows,
        count: needCount && paged ? read.count : undefined,
        shape,
        stripNulls: strip,
        ...formatOptions(format, qp),
      }),
    };
  }

  // GeoJSON is built for void functions too (and fails in PostGIS, like PostgREST).
  const shape: BodyShape =
    call.shape === "void" && !(format.kind === "rendered" && format.voidRows)
      ? "none"
      : call.shape === "scalar"
        ? "scalar"
        : "scalar-array";
  return { ...base, shape, statement: buildStatement({ rows: call.source, shape, ...formatOptions(format, qp) }) };
};

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

/**
 * What a statement came to. Nothing is parsed or dressed for a transport: `body` is the text the
 * statement made (see {@link shownBody}), `rows` the rows of the page, `total` the count the plan asked for
 * (see `Preferences.count`) and `settings` what {@link QueryParams.read} asked to be read afterwards.
 */
export interface SqlResult {
  readonly body: string;
  readonly rows: number;
  readonly total: number | undefined;
  readonly settings: ReadonlyArray<string | null>;
  /** An upsert that inserted no row (every one of them already existed). */
  readonly noneInserted: boolean;
}

/** What the statement made, before `shownBody` decides whether the caller wants it. */
interface RawResult {
  readonly rows: number;
  readonly body: string;
  readonly total: number | undefined;
  readonly planned: number | undefined;
  readonly settings: ReadonlyArray<string | null>;
  readonly noneInserted: boolean;
}

/** How a call runs, beyond what the plan says. */
export interface ExecuteOptions {
  /** Roll the transaction back instead of committing it: the statement runs, nothing stays. */
  readonly rollback?: boolean | undefined;
  /** Do not run the statement: answer with `EXPLAIN` of it, in this format, and roll back. */
  readonly explain?: { readonly format: "json" | "text"; readonly options: ReadonlyArray<string> } | undefined;
}

/**
 * The body a caller shows: what the statement made for a read or a function call, nothing for a write
 * that does not return its rows.
 */
export const shownBody = (plan: SqlPlan, body: string): string => {
  if (plan.kind === "read" || plan.kind === "rpc") return body;
  if ((plan.returning ?? "minimal") !== "representation") return "";
  return plan.shape === "none" ? "" : body;
};

export const execute = async (
  env: SqlEnv,
  ctx: SqlRequestContext,
  call: SqlCall,
  schema: string,
  prefer: SqlPreferences,
  format: SqlOutputFormat,
  plan: SqlPlan,
  options: ExecuteOptions = {},
): Promise<SqlResult> => {
  const wantsPlan = options.explain;
  const { role, claims } = identityOf(env, ctx);
  // Inside a scope the transaction is already open and already carries the identity: this call
  // only says where its own statement runs, and owns neither the boundary nor what READ ONLY and a
  // replay would decide for every other query in the same transaction.
  const session = env.session;
  const setup = setConfigSql(ctxEntries(env, ctx, role, claims, call, schema, prefer, session ? "statement" : "both"));
  const strict = prefer.handling === "strict";
  const rollback = options.rollback === true || wantsPlan !== undefined;

  const attempt = async (): Promise<RawResult> => {
    try {
      const body = async (s: DbSession): Promise<RawResult> => {
        if (plan.readOnly && !session) await s.query("SET TRANSACTION READ ONLY");
        await s.query(setup.sql, setup.params);

        if (call.before) await call.before(s);

        let planned: number | undefined;
        if (plan.planned) {
          const ex = await s.query(
            `EXPLAIN (FORMAT JSON) ${plan.planned}`,
            plan.params.length ? plan.params : undefined,
          );
          const cell = ex[0]?.["QUERY PLAN"];
          const parsed = typeof cell === "string" ? JSON.parse(cell) : cell;
          const n = Number((parsed as any)?.[0]?.Plan?.["Plan Rows"]);
          planned = Number.isFinite(n) ? n : undefined;
        }

        if (wantsPlan) {
          const opts = ["FORMAT " + wantsPlan.format.toUpperCase(), ...wantsPlan.options.map((o) => o.toUpperCase())];
          const lines = await s.query(`EXPLAIN (${opts.join(", ")}) ${plan.statement}`, plan.params);
          const cells = lines.map((l) => l["QUERY PLAN"]);
          const text =
            wantsPlan.format === "json"
              ? typeof cells[0] === "string"
                ? cells[0]
                : JSON.stringify(cells[0], null, 2)
              : cells.join("\n");
          throw new RollbackWith({
            rows: 0,
            body: text,
            total: undefined,
            planned: undefined,
            settings: [],
            noneInserted: false,
          } satisfies RawResult);
        }

        const rows = await s.query(plan.statement, plan.params);
        const row = rows[0] ?? {};
        const pageTotal = Number(row["page_total"] ?? 0);
        const raw: RawResult = {
          rows: pageTotal,
          body: String(row["body"] ?? ""),
          total: row["total_result_set"] == null ? undefined : Number(row["total_result_set"]),
          planned,
          settings: settingsOf(row),
          noneInserted:
            row["none_inserted"] === true || row["none_inserted"] === "true" || row["none_inserted"] === "t",
        };

        // Checks that must roll back the transaction when they fail.
        if (format.kind === "object" && plan.shape === "object" && plan.rpc?.shape !== "object" && pageTotal !== 1) {
          throw new EngineError(
            "not_single_row",
            "Cannot coerce the result to a single JSON object",
            `The result contains ${pageTotal} rows`,
          );
        }
        if (strict && prefer.maxAffected !== undefined) {
          if (plan.kind === "rpc" && plan.rpc && !plan.rpc.fn.returnsSet) {
            throw new EngineError(
              "max_affected_unsupported",
              "max-affected preference is only valid for functions that return a set",
              null,
              null,
            );
          }
          if (
            (plan.kind === "update" || plan.kind === "delete" || plan.kind === "rpc") &&
            pageTotal > prefer.maxAffected
          ) {
            throw new EngineError(
              "too_many_affected",
              "Query result exceeds max-affected preference constraint",
              `The query affects ${pageTotal} rows`,
            );
          }
        }
        if (rollback) throw new RollbackWith(raw);
        return raw;
      };
      return session ? await body(session) : await env.db.transaction(body);
    } catch (e) {
      if (e instanceof RollbackWith) return e.value as RawResult;
      // The root table is aliased internally; PostgreSQL error texts should name the real table.
      if (e instanceof DbQueryError && plan.kind !== "rpc" && plan.rel) {
        const fix = (t: string | undefined) =>
          t?.replaceAll(`"${ROOT_ALIAS}"`, `"${plan.rel!.name}"`).replaceAll(`${ROOT_ALIAS}.`, `${plan.rel!.name}.`);
        throw new DbQueryError(e.sqlState, fix(e.message) ?? e.message, fix(e.detail), fix(e.hint));
      }
      throw e;
    }
  };

  // Serialization failures are safe to retry: the whole transaction rolled back.
  let result: RawResult | undefined;
  for (let i = 0; ; i++) {
    try {
      result = await attempt();
      break;
    } catch (e) {
      // A scope decides its own replay: rerunning the transaction means rerunning its callback.
      if (e instanceof DbQueryError && e.sqlState === "40001" && i < 2 && !session) continue;
      throw e;
    }
  }

  // an EXPLAIN is its text, whatever the format it describes
  if (wantsPlan) return { ...result, total: undefined };
  return {
    body: result.body,
    rows: result.rows,
    total: totalOf(env, prefer, plan, result),
    settings: result.settings,
    noneInserted: result.noneInserted,
  };
};

/** The `setting_<n>` columns of the statement's row, in order. */
const settingsOf = (row: Record<string, unknown>): Array<string | null> => {
  const out: Array<string | null> = [];
  for (let i = 0; `setting_${i}` in row; i++)
    out.push(row[`setting_${i}`] == null ? null : String(row[`setting_${i}`]));
  return out;
};

/**
 * The count a call asked for (`Preferences.count`). A read or a function call counts what the plan counted;
 * a write only knows how many rows it touched, which is the count when it is `exact`.
 */
const totalOf = (env: SqlEnv, prefer: SqlPreferences, plan: SqlPlan, r: RawResult): number | undefined => {
  if (plan.kind !== "read" && plan.kind !== "rpc") return prefer.count === "exact" ? r.rows : undefined;
  let total: number | undefined;
  if (prefer.count === "exact") total = plan.countInStatement ? r.total : r.rows;
  else if (prefer.count === "planned") total = r.planned;
  else if (prefer.count === "estimated") {
    const max = env.config.maxRows;
    total =
      max !== undefined && r.planned !== undefined && r.planned > max
        ? r.planned
        : plan.countInStatement
          ? r.total
          : r.rows;
  }
  const pagedRead =
    plan.kind === "read" || (plan.pagedRead !== undefined && (plan.shape === "array" || plan.shape === "object"));
  if (
    pagedRead &&
    total !== undefined &&
    plan.offset > 0 &&
    r.rows === 0 &&
    plan.offset >= total &&
    prefer.count !== "planned"
  ) {
    throw new EngineError(
      "range_not_satisfiable",
      "Requested range not satisfiable",
      `An offset of ${plan.offset} was requested, but there are only ${total} rows.`,
      null,
      { total },
    );
  }
  return total;
};
