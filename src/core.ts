import type { DbAdapter, DbSession } from "./adapter";
import { DbQueryError, PgRestError } from "./errors";
import { parseQuery, type ParsedQuery } from "./parse/filter";
import { OPERATORS_ORDER } from "./parse/syntax";
import {
  type Method,
  type OutputFormat,
  type Preferences,
  parseAccept,
  parseBody,
  isSupportedMethod,
  parseMethod,
  parsePrefer,
  parseRange,
  parseTarget,
} from "./parse/request";
import { mediaChoices } from "./media";
import { literal, quoteIdent } from "./quote";
import { buildOpenApi } from "./openapi";
import { getRelation, type Relation, type SchemaCache } from "./schema";
import { buildRead } from "./sql/read";
import { buildRpc, isSingleUnnamedParam, resolveFunction, type RpcCall } from "./sql/rpc";
import { buildStatement, type BodyShape } from "./sql/statement";
import { buildDelete, buildInsert, upsertColumns, buildUpdate, type JsonObject, type Returning } from "./sql/write";

/** Who is making the request, as far as the database is concerned. */
export interface RequestContext {
  /** Database role to run the request as. Defaults to the anonymous role. */
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

export interface PreRequestInfo {
  readonly role: string;
  readonly claims: Readonly<Record<string, unknown>>;
  readonly method: Method;
  readonly path: string;
  /** The HTTP request, when the call came through `handle()`. In-process `query()` calls have none. */
  readonly request?: Request | undefined;
}

export interface CoreConfig {
  readonly schemas: ReadonlyArray<string>;
  /** Role for requests without one; `undefined` refuses anonymous access (PGRST302). */
  readonly anonymousRole: string | undefined;
  readonly maxRows?: number | undefined;
  readonly basePath: string;
  readonly extraSearchPath: ReadonlyArray<string>;
  /** Honor `Prefer: tx=rollback|commit` (PostgREST `db-tx-end`). */
  readonly allowTxOverride: boolean;
  /** Answer `Accept: application/vnd.pgrst.plan` with the query plan. */
  readonly planEnabled: boolean;
  readonly openApi: boolean;
  /** Expose `request.headers` / `request.cookies` / `request.method` / `request.path` to SQL. */
  readonly requestSettings: boolean;
  /** SQL function (`"auth"."check"`) or callback run in the transaction before the request (db-pre-request). */
  readonly preRequest?: string | ((session: DbSession, info: PreRequestInfo) => Promise<void>) | undefined;
  readonly serverUrl?: string | undefined;
}

export interface Env {
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
 * Where a call came from. `handle()` passes the HTTP request; `query()` runs in-process and has no
 * headers, so SQL sees an empty `request.headers` / `request.cookies`.
 */
export interface Caller {
  /** What SQL reads as `request.path`. */
  readonly path: string;
  readonly headers?: Headers | undefined;
  /** The HTTP request, when there is one. Passed through to `preRequest`. */
  readonly request?: Request | undefined;
}

/** A query string, read once: what `parseQuery` takes, plus the bare keys (`?a&b`) it must ignore. */
export interface QueryParams {
  readonly params: ReadonlyArray<readonly [string, string]>;
  readonly bare: ReadonlySet<string>;
  /**
   * `SET` clauses already compiled to SQL, for an update: the expressions of `query()`'s `set`
   * (`sql/expression.ts`). Only `query()` fills it; a PATCH over HTTP is PostgREST's, a JSON body.
   */
  readonly setClauses?: ReadonlyArray<string> | undefined;
}

/** The bare keys of a query string: `?a&b=1` -> `{a}`. They are arguments, never filters. */
export const bareKeys = (search: string): Set<string> => {
  const out = new Set<string>();
  for (const kv of search.slice(1).split("&")) {
    if (kv !== "" && !kv.includes("=")) out.add(decodeURIComponent(kv));
  }
  return out;
};

/** Statement options that depend on the negotiated output format. */
const formatOptions = (format: OutputFormat) => ({
  csv: format.kind === "csv",
  geojson: format.kind === "geojson",
  handler: format.kind === "handler" ? format.choice : undefined,
});

const JSON_CT = "application/json; charset=utf-8";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": JSON_CT, ...headers } });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The schema a call runs against: the one it asks for, if exposed, else the default one. */
export const useSchema = (env: Env, wanted: string | null | undefined): string => {
  const name = wanted?.trim();
  if (!name) return env.config.schemas[0]!;
  if (!env.config.schemas.includes(name)) {
    throw new PgRestError(
      406,
      "PGRST106",
      `Invalid schema: ${name}`,
      null,
      `Only the following schemas are exposed: ${env.config.schemas.join(", ")}`,
    );
  }
  return name;
};

const readSchema = (env: Env, request: Request, method: Method): string =>
  useSchema(
    env,
    method === "GET" || method === "HEAD"
      ? request.headers.get("accept-profile")
      : request.headers.get("content-profile"),
  );

/** Refuse a call that has no role when anonymous access is disabled. */
export const assertRole = (env: Env, ctx: RequestContext): void => {
  if (!ctx.role && env.config.anonymousRole === undefined) {
    throw new PgRestError(401, "PGRST302", "Anonymous access is disabled", null, null);
  }
};

const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const v = part
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, "");
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
};

/** Who is asking, as the database reads it. In a scope this half is issued once, on entry. */
const whoEntries = (role: string, claims: Record<string, unknown>): Array<[string, string]> => [
  ["role", role],
  ["request.jwt.claims", JSON.stringify(claims)],
];

/** The caller's own settings, which go last so one of them wins over a setting of ours it names. */
const settingsEntries = (ctx: RequestContext): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(ctx.settings ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_.]+$/.test(k)) {
      throw new PgRestError(
        500,
        "PGRST100",
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
 * statement runs -- the schema, the request SQL reads, the time zone it asked for -- and is all a
 * query inside a transaction scope issues: the identity was set once, on entry, because
 * `set_config` is transaction-local and re-issuing the role halfway through scopes nothing. This
 * half stays per statement, which is what lets two queries of one scope name two schemas.
 */
const ctxEntries = (
  env: Env,
  ctx: RequestContext,
  role: string,
  claims: Record<string, unknown>,
  caller: Caller,
  method: Method,
  schema: string,
  prefer: Preferences,
  part: "statement" | "both",
): Array<[string, string]> => {
  const where: Array<[string, string]> = [];
  if (env.config.requestSettings) {
    const headers: Record<string, string> = {};
    caller.headers?.forEach((v, k) => {
      headers[k] = v;
    });
    where.push(
      ["request.method", method],
      ["request.path", caller.path],
      ["request.headers", JSON.stringify(headers)],
      ["request.cookies", JSON.stringify(parseCookies(caller.headers?.get("cookie") ?? null))],
    );
  }
  const searchPath = [schema, ...env.config.extraSearchPath].map(quoteIdent).join(", ");
  where.push(["search_path", searchPath]);
  if (prefer.timezone) where.push(["timezone", prefer.timezone]);
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
export const transactionSetup = (env: Env, ctx: RequestContext): { sql: string; params: string[] } => {
  const role = ctx.role ?? env.config.anonymousRole!;
  const claims: Record<string, unknown> = { role, ...(ctx.claims ?? {}) };
  return setConfigSql([...whoEntries(role, claims), ...settingsEntries(ctx)]);
};

/** Parsed `response.headers` GUC: `[{"X-A": "b"}, ...]`. */
const parseResponseHeaders = (raw: unknown): Record<string, string> => {
  if (raw == null || raw === "") return {};
  const bad = () =>
    new PgRestError(
      500,
      "PGRST111",
      "response.headers guc must be a JSON array composed of objects with a single key and a string value",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw bad();
  }
  if (!Array.isArray(parsed)) throw bad();
  const out: Record<string, string> = {};
  for (const h of parsed) {
    if (!h || typeof h !== "object" || Array.isArray(h)) throw bad();
    const keys = Object.keys(h);
    if (keys.length !== 1) throw bad();
    const v = (h as Record<string, unknown>)[keys[0]!];
    if (typeof v !== "string") throw bad();
    out[keys[0]!] = v;
  }
  return out;
};

const parseStatusGuc = (raw: unknown): number | undefined => {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 100 || n > 599) {
    throw new PgRestError(500, "PGRST112", "response.status guc must be a valid status code");
  }
  return n;
};

const appliedHeader = (p: Preferences, honoredTx: boolean): string | undefined => {
  const parts: string[] = [];
  if (honoredTx && p.tx) parts.push(`tx=${p.tx}`);
  if (p.return) parts.push(`return=${p.return}`);
  if (p.count) parts.push(`count=${p.count}`);
  if (p.resolution) parts.push(`resolution=${p.resolution}`);
  if (p.missing) parts.push(`missing=${p.missing}`);
  if (p.handling) parts.push(`handling=${p.handling}`);
  if (p.timezone) parts.push(`timezone=${p.timezone}`);
  if (p.maxAffected !== undefined && p.handling === "strict") parts.push(`max-affected=${p.maxAffected}`);
  return parts.length ? parts.join(", ") : undefined;
};

class RollbackWith<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}

// ---------------------------------------------------------------------------
// plans
// ---------------------------------------------------------------------------

export interface Plan {
  readonly method: Method;
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
    if (!body.every(isObj)) throw new PgRestError(400, "PGRST102", "All object keys must match");
    return body as JsonObject[];
  }
  // PostgREST inserts nothing for a scalar payload.
  return isObj(body) ? [body] : [];
};

const effectivePaging = (env: Env, query: ParsedQuery, range: { offset: number; limit?: number } | undefined) => {
  if (query.root.limit !== undefined && query.root.limit < 0) {
    throw new PgRestError(
      416,
      "PGRST103",
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
// entry point
// ---------------------------------------------------------------------------

export const handleRequest = async (env: Env, request: Request, ctx: RequestContext): Promise<Response> => {
  assertRole(env, ctx);
  // like PostgREST's web server, answer other methods (TRACE...) with an empty 405
  if (!isSupportedMethod(request.method))
    return new Response(null, { status: 405, headers: { "Content-Type": JSON_CT } });
  const method = parseMethod(request.method);
  const url = new URL(request.url);
  const target = parseTarget(url.pathname, env.config.basePath);
  const schema = readSchema(env, request, method);
  const prefer = parsePrefer(request.headers.get("prefer"));
  const invalid = [...prefer.invalid];
  const honoredTx = env.config.allowTxOverride;
  if (prefer.tx && !honoredTx) invalid.push(`tx=${prefer.tx}`);
  if (prefer.handling === "strict" && invalid.length > 0) {
    throw new PgRestError(
      400,
      "PGRST122",
      "Invalid preferences given with handling=strict",
      `Invalid preferences: ${invalid.join(", ")}`,
    );
  }

  if (method === "OPTIONS") {
    const allow =
      target.type === "root"
        ? "OPTIONS,GET,HEAD"
        : target.type === "rpc"
          ? "OPTIONS,GET,HEAD,POST"
          : (() => {
              const rel = getRelation(env.cache, schema, target.name);
              const m = ["OPTIONS", "GET", "HEAD"];
              if (rel.insertable) m.push("POST");
              if (rel.insertable && rel.updatable) m.push("PUT");
              if (rel.updatable) m.push("PATCH");
              if (rel.deletable) m.push("DELETE");
              return m.join(",");
            })();
    return new Response(null, { status: 200, headers: { Allow: allow } });
  }

  if (target.type === "root") {
    if (method !== "GET" && method !== "HEAD")
      throw new PgRestError(405, "PGRST117", `Unsupported HTTP method: ${method}`);
    if (!env.config.openApi) throw new PgRestError(404, "PGRST126", "Root endpoint metadata is disabled");
    parseAccept(request.headers.get("accept"), true);
    const doc = buildOpenApi(env.cache, schema, {
      serverUrl: env.config.serverUrl ?? url.origin,
      basePath: env.config.basePath,
    });
    return new Response(method === "HEAD" ? null : JSON.stringify(doc), {
      status: 200,
      headers: { "Content-Type": "application/openapi+json; charset=utf-8" },
    });
  }

  const requested = parseAccept(
    request.headers.get("accept"),
    false,
    env.config.planEnabled,
    mediaChoices(env.cache, schema, target, url.searchParams.has("select")),
  );
  const format = requested.kind === "plan" ? requested.inner : requested;
  const wantsPlan = requested.kind === "plan" ? requested : undefined;
  const range = parseRange(request.headers.get("range"), request.headers.get("range-unit"));
  const body = await parseBody(request, method);

  const qp: QueryParams = { params: [...url.searchParams], bare: bareKeys(url.search) };
  let plan: Plan;
  if (target.type === "table") {
    plan = planTable(env, method, schema, target.name, qp, prefer, format, range, body);
  } else {
    plan = planRpc(env, method, schema, target.name, qp, prefer, format, range, body);
  }

  const caller: Caller = { path: url.pathname, headers: request.headers, request };
  return execute(env, ctx, caller, method, schema, prefer, format, plan, honoredTx, wantsPlan);
};

// ---------------------------------------------------------------------------
// planning: tables
// ---------------------------------------------------------------------------

export const planTable = (
  env: Env,
  method: Method,
  schema: string,
  name: string,
  qp: QueryParams,
  prefer: Preferences,
  format: OutputFormat,
  range: { offset: number; limit?: number } | undefined,
  body: { kind: string; value: unknown } | undefined,
): Plan => {
  const rel = getRelation(env.cache, schema, name);
  const query = parseQuery(qp.params);
  const strip = format.kind === "json" || format.kind === "object" ? format.stripNulls : false;
  const singular = format.kind === "object";

  if (method === "GET" || method === "HEAD") {
    const { limit, offset } = effectivePaging(env, query, range);
    const read = buildRead({
      cache: env.cache,
      rel,
      from: `${quoteIdent(rel.schema)}.${quoteIdent(rel.name)}`,
      query,
      limit,
      offset,
    });
    const shape: BodyShape = singular ? "object" : "array";
    const paged = limit !== undefined || offset > 0;
    const needCount = prefer.count === "exact" || prefer.count === "estimated";
    return {
      method,
      kind: "read",
      readOnly: true,
      source: false,
      params: [],
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
        ...formatOptions(format),
      }),
    };
  }

  const returning: Returning =
    prefer.return === "representation" ? "representation" : prefer.return === "headers-only" ? "pk" : "minimal";
  const shapeFor = (r: Returning): BodyShape =>
    r === "representation" ? (singular ? "object" : "array") : r === "pk" ? "array" : "none";
  const rowsFor = (r: Returning): { rows: string; shape: BodyShape } => {
    if (r === "representation") {
      // The request's filters selected the rows to write; they must not be applied
      // again to the rows that were written (an UPDATE may no longer match them).
      const resultQuery: ParsedQuery = { ...query, root: { ...query.root, filters: [], presence: [] } };
      const read = buildRead({ cache: env.cache, rel, from: "pgrst_source", query: resultQuery });
      return { rows: read.rows, shape: shapeFor(r) };
    }
    return { rows: "SELECT * FROM pgrst_source", shape: shapeFor(r) };
  };

  const common = {
    method,
    rel,
    readOnly: false,
    source: true,
    offset: 0,
    countInStatement: false,
    pagedRead: false,
  } as const;

  if (method === "POST") {
    if (!body) throw new PgRestError(400, "PGRST102", "Empty or invalid json");
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
        ...formatOptions(format),
        upsertColumns: insertSql.includes("pgrst_inserted") ? upsertColumns(rel, returning) : undefined,
      }),
    };
  }

  if (method === "PATCH") {
    if (!body) throw new PgRestError(400, "PGRST102", "Empty or invalid json");
    // PostgREST uses the first element of an array and treats other payloads as "no columns".
    const first = Array.isArray(body.value) ? body.value[0] : body.value;
    const obj: JsonObject =
      first !== null && typeof first === "object" && !Array.isArray(first) ? (first as JsonObject) : {};
    const updateSql = buildUpdate({
      rel,
      body: obj as JsonObject,
      clauses: qp.setClauses,
      filters: query.root.filters,
      returning,
    });
    const { rows: outRows, shape } = rowsFor(returning);
    if (updateSql === null) {
      // Nothing to set: the request matches rows but changes none.
      const emptyShape: BodyShape = returning === "representation" ? (singular ? "object" : "array") : "none";
      return {
        ...common,
        kind: "update",
        returning,
        params: [],
        shape: emptyShape,
        statement: buildStatement({
          source: "SELECT 1 WHERE FALSE",
          rows: "SELECT * FROM pgrst_source",
          shape: emptyShape,
          ...formatOptions(format),
        }),
      };
    }
    return {
      ...common,
      kind: "update",
      returning,
      params: Object.keys(obj).length ? [JSON.stringify(obj)] : [],
      shape,
      statement: buildStatement({
        source: updateSql,
        rows: outRows,
        shape,
        stripNulls: strip,
        ...formatOptions(format),
      }),
    };
  }

  if (method === "DELETE") {
    const deleteSql = buildDelete({ rel, filters: query.root.filters, returning });
    const { rows: outRows, shape } = rowsFor(returning);
    return {
      ...common,
      kind: "delete",
      returning,
      params: [],
      shape,
      statement: buildStatement({
        source: deleteSql,
        rows: outRows,
        shape,
        stripNulls: strip,
        ...formatOptions(format),
      }),
    };
  }

  // PUT: single-row upsert addressed by primary key.
  if (!body) throw new PgRestError(400, "PGRST102", "Empty or invalid json");
  const row = body.value;
  if (Array.isArray(row) && !row.every((r) => r !== null && typeof r === "object" && !Array.isArray(r))) {
    throw new PgRestError(400, "PGRST102", "All object keys must match");
  }
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new PgRestError(
      400,
      "PGRST102",
      "Empty or invalid json",
      "The payload of a PUT request must be a JSON object",
    );
  }
  if (query.root.limit !== undefined || query.root.offset !== undefined) {
    throw new PgRestError(400, "PGRST114", "limit/offset querystring parameters are not allowed for PUT");
  }
  if (rel.pk.length === 0) {
    throw new PgRestError(405, "PGRST105", "Filters must include all and only primary key columns with 'eq' operators");
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
      throw new PgRestError(
        405,
        "PGRST105",
        "Filters must include all and only primary key columns with 'eq' operators",
      );
    }
  }
  if (!rel.pk.every((c) => keyValues.has(c))) {
    throw new PgRestError(405, "PGRST105", "Filters must include all and only primary key columns with 'eq' operators");
  }
  const obj = row as JsonObject;
  for (const c of rel.pk) {
    if (c in obj && String(obj[c]) !== keyValues.get(c)) {
      throw new PgRestError(400, "PGRST115", "Payload values do not match URL in primary key column(s)");
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
    statement: buildStatement({ source: putSql, rows: outRows, shape, stripNulls: strip, ...formatOptions(format) }),
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
  env: Env,
  method: Method,
  schema: string,
  name: string,
  qp: QueryParams,
  prefer: Preferences,
  format: OutputFormat,
  range: { offset: number; limit?: number } | undefined,
  body: { kind: string; value: unknown } | undefined,
): Plan => {
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    throw new PgRestError(405, "PGRST101", `Cannot use the ${method} method on RPC`);
  }

  let argValues: Record<string, unknown> = {};
  let nonObjectBody = false;
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const getArgKeys = new Set<string>();
  const bare = qp.bare;

  if (method === "POST") {
    if (body) {
      const v = body.value;
      if (isObj(v)) argValues = v;
      else {
        nonObjectBody = true;
        if (Array.isArray(v) && v.length > 0) {
          // PostgREST reads the function arguments from the objects of an array body; they must agree on their keys
          const keysOf = (o: unknown) => (isObj(o) ? Object.keys(o).sort().join("\u0000") : undefined);
          const first = keysOf(v[0]);
          if (first === undefined || v.some((o) => keysOf(o) !== first)) {
            throw new PgRestError(400, "PGRST102", "All object keys must match", null, null);
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
  const fn = resolveFunction(env.cache, schema, name, new Set(provided), nonObjectBody, method === "POST");
  // GET: repeated parameters make a list, and a variadic parameter always takes one
  for (const a of fn.args) {
    if (a.variadic && getArgKeys.has(a.name) && !Array.isArray(argValues[a.name]))
      argValues[a.name] = [argValues[a.name]];
  }
  const rawBody = nonObjectBody && isSingleUnnamedParam(fn);
  const call = buildRpc(env.cache, fn, provided, rawBody);

  const fnArgNames = new Set(fn.args.map((a) => a.name));
  const query = parseQuery(
    qp.params.filter(([k, v]) => !(v === "" && bare.has(k))),
    {
      // On GET, parameters that name function arguments are not filters.
      allowFilterKey: (k) => method === "POST" || !fnArgNames.has(k),
    },
  );
  const argsJson = rawBody ? JSON.stringify(body!.value) : JSON.stringify(argValues);
  const params = call.usesBody
    ? [rawBody && body!.kind === "json" && typeof body!.value === "string" ? (body!.value as string) : argsJson]
    : [];
  const strip = format.kind === "json" || format.kind === "object" ? format.stripNulls : false;

  const base = {
    method,
    kind: "rpc",
    readOnly: method !== "POST",
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
    const read = buildRead({ cache: env.cache, rel: call.relation, from: `(${call.source})`, query, limit, offset });
    const shape: BodyShape = call.shape === "object" || format.kind === "object" ? "object" : "array";
    const paged = limit !== undefined || offset > 0;
    const needCount = prefer.count === "exact" || prefer.count === "estimated";
    return {
      ...base,
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
        ...formatOptions(format),
      }),
    };
  }

  // GeoJSON is built for void functions too (and fails in PostGIS, like PostgREST).
  const shape: BodyShape =
    call.shape === "void" && format.kind !== "geojson" ? "none" : call.shape === "scalar" ? "scalar" : "scalar-array";
  return { ...base, shape, statement: buildStatement({ rows: call.source, shape, ...formatOptions(format) }) };
};

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface RawResult {
  readonly pageTotal: number;
  readonly body: string;
  readonly total: number | undefined;
  readonly planned: number | undefined;
  readonly responseHeaders: Record<string, string>;
  readonly responseStatus: number | undefined;
}

export const execute = async (
  env: Env,
  ctx: RequestContext,
  caller: Caller,
  method: Method,
  schema: string,
  prefer: Preferences,
  format: OutputFormat,
  plan: Plan,
  honoredTx: boolean,
  wantsPlan?: Extract<OutputFormat, { kind: "plan" }>,
): Promise<Response> => {
  const role = ctx.role ?? env.config.anonymousRole!;
  const claims: Record<string, unknown> = { role, ...(ctx.claims ?? {}) };
  // Inside a scope the transaction is already open and already carries the identity: this call
  // only says where its own statement runs, and owns neither the boundary nor what READ ONLY and a
  // replay would decide for every other query in the same transaction.
  const session = env.session;
  const setup = setConfigSql(
    ctxEntries(env, ctx, role, claims, caller, method, schema, prefer, session ? "statement" : "both"),
  );
  const strict = prefer.handling === "strict";
  const rollback = (honoredTx && prefer.tx === "rollback") || wantsPlan !== undefined;

  const attempt = async (): Promise<RawResult> => {
    try {
      const body = async (s: DbSession): Promise<RawResult> => {
        if (plan.readOnly && !session) await s.query("SET TRANSACTION READ ONLY");
        await s.query(setup.sql, setup.params);

        const pre = env.config.preRequest;
        if (typeof pre === "string") {
          await s.query(`SELECT ${pre.split(".").map(quoteIdent).join(".")}()`);
        } else if (pre) {
          await pre(s, { role, claims, method, path: caller.path, request: caller.request });
        }

        let planned: number | undefined;
        if (plan.planned) {
          const ex = await s.query(`EXPLAIN (FORMAT JSON) ${plan.planned}`);
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
            pageTotal: 0,
            body: text,
            total: undefined,
            planned: undefined,
            responseHeaders: {},
            responseStatus: undefined,
          } satisfies RawResult);
        }

        const rows = await s.query(plan.statement, plan.params);
        const row = rows[0] ?? {};
        const pageTotal = Number(row["page_total"] ?? 0);
        const raw: RawResult = {
          pageTotal,
          body: String(row["body"] ?? ""),
          total: row["total_result_set"] == null ? undefined : Number(row["total_result_set"]),
          planned,
          responseHeaders: parseResponseHeaders(row["response_headers"]),
          responseStatus: parseStatusGuc(row["response_status"]),
        };

        // Checks that must roll back the transaction when they fail.
        if (format.kind === "object" && plan.shape === "object" && plan.rpc?.shape !== "object" && pageTotal !== 1) {
          throw new PgRestError(
            406,
            "PGRST116",
            "Cannot coerce the result to a single JSON object",
            `The result contains ${pageTotal} rows`,
          );
        }
        if (strict && prefer.maxAffected !== undefined) {
          if (plan.kind === "rpc" && plan.rpc && !plan.rpc.fn.returnsSet) {
            throw new PgRestError(
              400,
              "PGRST128",
              "max-affected preference is only valid for functions that return a set",
              null,
              null,
            );
          }
          if (
            (plan.kind === "update" || plan.kind === "delete" || plan.kind === "rpc") &&
            pageTotal > prefer.maxAffected
          ) {
            throw new PgRestError(
              400,
              "PGRST124",
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
          t?.replace(/"pgrst_root"/g, `"${plan.rel!.name}"`).replace(/pgrst_root\./g, `${plan.rel!.name}.`);
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

  if (wantsPlan) {
    const opts = wantsPlan.options.length ? `; options=${wantsPlan.options.join("|")}` : "";
    return new Response(method === "HEAD" ? null : result.body, {
      status: 200,
      headers: {
        "Content-Type": `application/vnd.pgrst.plan+${wantsPlan.format}; for="${wantsPlan.forType}"${opts}; charset=utf-8`,
        Vary: "Accept, Prefer, Range",
      },
    });
  }
  return buildResponse(env, method, prefer, format, plan, result, honoredTx);
};

// ---------------------------------------------------------------------------
// response
// ---------------------------------------------------------------------------

const buildResponse = (
  env: Env,
  method: Method,
  prefer: Preferences,
  format: OutputFormat,
  plan: Plan,
  r: RawResult,
  honoredTx: boolean,
): Response => {
  const headers: Record<string, string> = { Vary: "Accept, Prefer, Range" };
  const applied = appliedHeader(prefer, honoredTx);
  if (applied) headers["Preference-Applied"] = applied;

  // total rows, according to the requested count mode
  let total: number | undefined;
  if (prefer.count === "exact") total = plan.countInStatement ? r.total : r.pageTotal;
  else if (prefer.count === "planned") total = r.planned;
  else if (prefer.count === "estimated") {
    const max = env.config.maxRows;
    total =
      max !== undefined && r.planned !== undefined && r.planned > max
        ? r.planned
        : plan.countInStatement
          ? r.total
          : r.pageTotal;
  }
  const totalStr = total === undefined ? "*" : String(total);

  let status = 200;
  let text = r.body;
  let contentType = JSON_CT;

  if (
    plan.kind === "read" ||
    (plan.kind === "rpc" && plan.pagedRead !== undefined && (plan.shape === "array" || plan.shape === "object"))
  ) {
    const first = plan.offset;
    const last = plan.offset + r.pageTotal - 1;
    headers["Content-Range"] = r.pageTotal > 0 ? `${first}-${last}/${totalStr}` : `*/${totalStr}`;
    if (
      total !== undefined &&
      plan.offset > 0 &&
      r.pageTotal === 0 &&
      plan.offset >= total &&
      prefer.count !== "planned"
    ) {
      throw new PgRestError(
        416,
        "PGRST103",
        "Requested range not satisfiable",
        `An offset of ${plan.offset} was requested, but there are only ${total} rows.`,
        null,
        {
          "Content-Range": `*/${total}`,
          ...(applied ? { "Preference-Applied": applied } : {}),
        },
      );
    }
    if (total !== undefined && r.pageTotal > 0 && r.pageTotal < total) status = 206;
    if (total !== undefined && r.pageTotal === total && plan.offset > 0) status = 206;
  } else if (plan.kind === "rpc") {
    status = plan.shape === "none" ? 204 : 200;
    headers["Content-Range"] = r.pageTotal > 0 ? `0-${r.pageTotal - 1}/${totalStr}` : `*/${totalStr}`;
  } else {
    if (plan.kind === "update") {
      const n = r.pageTotal;
      headers["Content-Range"] =
        n > 0
          ? `0-${n - 1}/${prefer.count === "exact" ? String(n) : "*"}`
          : `*/${prefer.count === "exact" ? "0" : "*"}`;
    } else if (plan.kind !== "put") {
      headers["Content-Range"] = `*/${prefer.count === "exact" ? String(r.pageTotal) : "*"}`;
    }
    const ret = plan.returning ?? "minimal";
    if (plan.kind === "insert") {
      status = 201;
      if (ret === "pk") {
        const rows = JSON.parse(r.body || "[]") as Array<Record<string, unknown>>;
        const pk = plan.rel?.pk ?? [];
        if (rows.length === 1 && pk.length > 0) {
          const q = pk.map((c) => `${encodeURIComponent(c)}=eq.${encodeURIComponent(String(rows[0]![c]))}`).join("&");
          headers["Location"] = `/${encodeURIComponent(plan.rel!.name)}?${q}`;
        }
      }
    } else if (plan.kind === "put") {
      status = ret === "representation" ? 200 : 204;
    } else {
      status = ret === "representation" ? 200 : 204;
    }
    if (ret !== "representation") text = "";
    else if (plan.shape === "none") text = "";
  }

  if (plan.kind === "insert" && (plan.returning ?? "minimal") !== "representation") text = "";

  if (format.kind === "handler") {
    contentType = format.choice.contentType;
  } else if (format.kind === "csv") {
    contentType = "text/csv; charset=utf-8";
  } else if (format.kind === "geojson") {
    contentType = "application/geo+json; charset=utf-8";
  } else if (format.kind === "object") {
    contentType = `application/vnd.pgrst.object+json${format.stripNulls ? ";nulls=stripped" : ""}; charset=utf-8`;
  } else if (format.kind === "json" && format.stripNulls) {
    contentType = "application/vnd.pgrst.array+json;nulls=stripped; charset=utf-8";
  }

  Object.assign(headers, r.responseHeaders);
  if (r.responseStatus !== undefined) status = r.responseStatus;

  const noBody = status === 204 || status === 304 || text === "" || method === "HEAD";
  if (
    !(
      status === 204 ||
      status === 304 ||
      (text === "" && method !== "HEAD" && !(format.kind === "handler" && plan.kind === "read"))
    )
  )
    headers["Content-Type"] = contentType;
  if (!noBody && format.kind === "handler" && format.choice.bytea) {
    return new Response(Buffer.from(text, "hex"), { status, headers });
  }
  return new Response(noBody ? null : text, { status, headers });
};

export { json as jsonResponse };
