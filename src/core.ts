import type { DbAdapter, DbSession } from "./adapter";
import { DbQueryError, PgRestError } from "./errors";
import { parseQuery, type ParsedQuery } from "./parse/filter";
import {
  type Method,
  type OutputFormat,
  type Preferences,
  parseAccept,
  parseBody,
  parseMethod,
  parsePrefer,
  parseRange,
  parseTarget,
} from "./parse/request";
import { literal, quoteIdent } from "./quote";
import { buildOpenApi } from "./openapi";
import { getRelation, type Relation, type SchemaCache } from "./schema";
import { buildRead } from "./sql/read";
import { buildRpc, resolveFunction, type RpcCall } from "./sql/rpc";
import { buildStatement, type BodyShape } from "./sql/statement";
import { buildDelete, buildInsert, buildUpdate, type JsonObject, type Returning } from "./sql/write";

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
  readonly request: Request;
}

export interface CoreConfig {
  readonly schemas: ReadonlyArray<string>;
  readonly anonymousRole: string;
  readonly maxRows?: number | undefined;
  readonly basePath: string;
  readonly extraSearchPath: ReadonlyArray<string>;
  /** Honor `Prefer: tx=rollback|commit` (PostgREST `db-tx-end`). */
  readonly allowTxOverride: boolean;
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
}

const JSON_CT = "application/json; charset=utf-8";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": JSON_CT, ...headers } });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const readSchema = (env: Env, request: Request, method: Method): string => {
  const wanted = (method === "GET" || method === "HEAD" ? request.headers.get("accept-profile") : request.headers.get("content-profile"))?.trim();
  if (!wanted) return env.config.schemas[0]!;
  if (!env.config.schemas.includes(wanted)) {
    throw new PgRestError(
      406,
      "PGRST106",
      `Invalid schema: ${wanted}`,
      null,
      `Only the following schemas are exposed: ${env.config.schemas.join(", ")}`,
    );
  }
  return wanted;
};

const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const v = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
};

const applyCtxSql = (
  env: Env,
  ctx: RequestContext,
  role: string,
  claims: Record<string, unknown>,
  request: Request,
  method: Method,
  pathname: string,
  schema: string,
  prefer: Preferences,
): { sql: string; params: string[] } => {
  const entries: Array<[string, string]> = [["role", role], ["request.jwt.claims", JSON.stringify(claims)]];
  if (env.config.requestSettings) {
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k] = v;
    });
    entries.push(
      ["request.method", method],
      ["request.path", pathname],
      ["request.headers", JSON.stringify(headers)],
      ["request.cookies", JSON.stringify(parseCookies(request.headers.get("cookie")))],
    );
  }
  const searchPath = [schema, ...env.config.extraSearchPath].map(quoteIdent).join(", ");
  entries.push(["search_path", searchPath]);
  if (prefer.timezone) entries.push(["timezone", prefer.timezone]);
  for (const [k, v] of Object.entries(ctx.settings ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_.]+$/.test(k)) {
      throw new PgRestError(500, "PGRST100", `Invalid setting name "${k}"`, null, "Custom settings need a prefix, e.g. app.tenant_id");
    }
    entries.push([k, v]);
  }
  return {
    sql: `SELECT ${entries.map(([k], i) => `set_config(${literal(k)}, $${i + 1}::text, true)`).join(", ")}`,
    params: entries.map(([, v]) => v),
  };
};

/** Parsed `response.headers` GUC: `[{"X-A": "b"}, ...]`. */
const parseResponseHeaders = (raw: unknown): Record<string, string> => {
  if (raw == null || raw === "") return {};
  const bad = () =>
    new PgRestError(500, "PGRST111", "response.headers guc must be a JSON array composed of objects with a single key and a string value");
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

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsv = (bodyJson: string): string => {
  const rows = JSON.parse(bodyJson) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const cols = Object.keys(rows[0]!);
  return [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
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

interface Plan {
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

const asRows = (body: unknown, what: string): JsonObject[] => {
  const bad = () => new PgRestError(400, "PGRST102", "Empty or invalid json", `${what} must be a JSON object or an array of JSON objects`);
  const isObj = (v: unknown): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(body)) {
    if (!body.every(isObj)) throw bad();
    return body as JsonObject[];
  }
  if (isObj(body)) return [body];
  throw bad();
};

const effectivePaging = (env: Env, query: ParsedQuery, range: { offset: number; limit?: number } | undefined) => {
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
  const method = parseMethod(request.method);
  const url = new URL(request.url);
  const target = parseTarget(url.pathname, env.config.basePath);
  const schema = readSchema(env, request, method);
  const prefer = parsePrefer(request.headers.get("prefer"));
  const invalid = [...prefer.invalid];
  const honoredTx = env.config.allowTxOverride;
  if (prefer.tx && !honoredTx) invalid.push(`tx=${prefer.tx}`);
  if (prefer.handling === "strict" && invalid.length > 0) {
    throw new PgRestError(400, "PGRST122", "Invalid preferences given with handling=strict", `Invalid preferences: ${invalid.join(", ")}`);
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
    if (method !== "GET" && method !== "HEAD") throw new PgRestError(405, "PGRST117", `Unsupported HTTP method: ${method}`);
    if (!env.config.openApi) throw new PgRestError(404, "PGRST126", "Root endpoint metadata is disabled");
    parseAccept(request.headers.get("accept"), true);
    const doc = buildOpenApi(env.cache, schema, { serverUrl: env.config.serverUrl ?? url.origin, basePath: env.config.basePath });
    return new Response(method === "HEAD" ? null : JSON.stringify(doc), {
      status: 200,
      headers: { "Content-Type": "application/openapi+json; charset=utf-8" },
    });
  }

  const format = parseAccept(request.headers.get("accept"), false);
  const range = parseRange(request.headers.get("range"), request.headers.get("range-unit"));
  const body = await parseBody(request, method);

  let plan: Plan;
  if (target.type === "table") {
    plan = planTable(env, method, schema, target.name, url, prefer, format, range, body);
  } else {
    plan = planRpc(env, method, schema, target.name, url, prefer, format, range, body);
  }

  return execute(env, ctx, request, method, url.pathname, schema, prefer, format, plan, honoredTx);
};

// ---------------------------------------------------------------------------
// planning: tables
// ---------------------------------------------------------------------------

const planTable = (
  env: Env,
  method: Method,
  schema: string,
  name: string,
  url: URL,
  prefer: Preferences,
  format: OutputFormat,
  range: { offset: number; limit?: number } | undefined,
  body: { kind: string; value: unknown } | undefined,
): Plan => {
  const rel = getRelation(env.cache, schema, name);
  const query = parseQuery([...url.searchParams]);
  const strip = format.kind === "json" || format.kind === "object" ? format.stripNulls : false;
  const singular = format.kind === "object";

  if (method === "GET" || method === "HEAD") {
    const { limit, offset } = effectivePaging(env, query, range);
    const read = buildRead({ cache: env.cache, rel, from: `${quoteIdent(rel.schema)}.${quoteIdent(rel.name)}`, query, limit, offset });
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
      }),
    };
  }

  const returning: Returning =
    prefer.return === "representation" ? "representation" : prefer.return === "headers-only" ? "pk" : "minimal";
  const shapeFor = (r: Returning): BodyShape => (r === "representation" ? (singular ? "object" : "array") : r === "pk" ? "array" : "none");
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

  // Writes may not use embedded filters, limits or offsets.
  if (method !== "POST" && method !== "PUT" && (query.root.limit !== undefined || query.root.offset !== undefined)) {
    throw new PgRestError(400, "PGRST100", "limit and offset are not supported on PATCH, PUT and DELETE", null, null);
  }

  const common = { method, rel, readOnly: false, source: true, offset: 0, countInStatement: false, pagedRead: false } as const;

  if (method === "POST") {
    if (!body) throw new PgRestError(400, "PGRST102", "Empty or invalid json");
    const rows = asRows(body.value, "The payload");
    const insertSql = buildInsert({
      rel,
      rows,
      columns: query.columns,
      onConflict: query.onConflict,
      resolution: prefer.resolution,
      missingDefault: prefer.missing === "default",
      returning,
    });
    const { rows: outRows, shape } = rowsFor(returning);
    return {
      ...common,
      kind: "insert",
      returning,
      params: insertSql.includes("$1") ? [JSON.stringify(rows)] : [],
      shape,
      statement: buildStatement({ source: insertSql, rows: outRows, shape, stripNulls: strip }),
    };
  }

  if (method === "PATCH") {
    if (!body) throw new PgRestError(400, "PGRST102", "Empty or invalid json");
    const obj = body.value;
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new PgRestError(400, "PGRST102", "Empty or invalid json", "The payload of a PATCH request must be a JSON object");
    }
    const updateSql = buildUpdate({ rel, body: obj as JsonObject, filters: query.root.filters, returning });
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
        statement: buildStatement({ source: "SELECT 1 WHERE FALSE", rows: "SELECT * FROM pgrst_source", shape: emptyShape }),
      };
    }
    return {
      ...common,
      kind: "update",
      returning,
      params: [JSON.stringify(obj)],
      shape,
      statement: buildStatement({ source: updateSql, rows: outRows, shape, stripNulls: strip }),
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
      statement: buildStatement({ source: deleteSql, rows: outRows, shape, stripNulls: strip }),
    };
  }

  // PUT: single-row upsert addressed by primary key.
  if (!body) throw new PgRestError(400, "PGRST102", "Empty or invalid json");
  const row = body.value;
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new PgRestError(400, "PGRST102", "Empty or invalid json", "The payload of a PUT request must be a JSON object");
  }
  if (query.root.limit !== undefined || query.root.offset !== undefined) {
    throw new PgRestError(400, "PGRST114", "limit/offset querystring parameters are not allowed for PUT");
  }
  if (rel.pk.length === 0) {
    throw new PgRestError(405, "PGRST105", "Filters must include all and only primary key columns with 'eq' operators");
  }
  const keyValues = new Map<string, string>();
  for (const f of query.root.filters) {
    if (f.kind === "filter" && f.op === "eq" && !f.negate && !f.quantifier && f.field.json.length === 0 && typeof f.value === "string" && rel.pk.includes(f.field.name)) {
      keyValues.set(f.field.name, f.value);
    } else {
      throw new PgRestError(405, "PGRST105", "Filters must include all and only primary key columns with 'eq' operators");
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
    statement: buildStatement({ source: putSql, rows: outRows, shape, stripNulls: strip }),
  };
};

// ---------------------------------------------------------------------------
// planning: RPC
// ---------------------------------------------------------------------------

const planRpc = (
  env: Env,
  method: Method,
  schema: string,
  name: string,
  url: URL,
  prefer: Preferences,
  format: OutputFormat,
  range: { offset: number; limit?: number } | undefined,
  body: { kind: string; value: unknown } | undefined,
): Plan => {
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    throw new PgRestError(405, "PGRST101", `Cannot use the ${method} method on RPC`);
  }
  const candidates = env.cache.functions.get(`${schema}.${name}`) ?? [];
  const allArgNames = new Set(candidates.flatMap((f) => f.args.map((a) => a.name)));
  const RESERVED = new Set(["select", "order", "limit", "offset", "and", "or", "columns", "on_conflict"]);

  let argValues: Record<string, unknown> = {};
  let rawBody = false;
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

  if (method === "POST") {
    if (body) {
      if (isObj(body.value)) argValues = body.value;
      else rawBody = true;
    }
  } else {
    for (const [k, v] of url.searchParams) {
      if (!RESERVED.has(k) && allArgNames.has(k)) argValues[k] = v;
    }
  }
  const provided = Object.keys(argValues);
  const fn = resolveFunction(env.cache, schema, name, new Set(provided), rawBody);
  const call = buildRpc(env.cache, fn, provided, rawBody);

  const fnArgNames = new Set(fn.args.map((a) => a.name));
  const query = parseQuery([...url.searchParams], {
    // On GET, parameters that name function arguments are not filters.
    allowFilterKey: (k) => method === "POST" || !fnArgNames.has(k),
  });
  const argsJson = rawBody ? JSON.stringify(body!.value) : JSON.stringify(argValues);
  const params = call.usesBody ? [rawBody && body!.kind === "json" && typeof body!.value === "string" ? (body!.value as string) : argsJson] : [];
  const strip = format.kind === "json" || format.kind === "object" ? format.stripNulls : false;

  const base = { method, kind: "rpc", readOnly: method !== "POST", source: false, rpc: call, rel: call.relation, params, offset: 0, countInStatement: false, pagedRead: false } as const;

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
      statement: buildStatement({ rows: read.rows, count: needCount && paged ? read.count : undefined, shape, stripNulls: strip }),
    };
  }

  const shape: BodyShape = call.shape === "void" ? "none" : call.shape === "scalar" ? "scalar" : "scalar-array";
  return { ...base, shape, statement: buildStatement({ rows: call.source, shape }) };
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

const execute = async (
  env: Env,
  ctx: RequestContext,
  request: Request,
  method: Method,
  pathname: string,
  schema: string,
  prefer: Preferences,
  format: OutputFormat,
  plan: Plan,
  honoredTx: boolean,
): Promise<Response> => {
  const role = ctx.role ?? env.config.anonymousRole;
  const claims: Record<string, unknown> = { role, ...(ctx.claims ?? {}) };
  const setup = applyCtxSql(env, ctx, role, claims, request, method, pathname, schema, prefer);
  const strict = prefer.handling === "strict";
  const rollback = honoredTx && prefer.tx === "rollback";

  const attempt = async (): Promise<RawResult> => {
    try {
      return await env.db.transaction(async (s) => {
        if (plan.readOnly) await s.query("SET TRANSACTION READ ONLY");
        await s.query(setup.sql, setup.params);

        const pre = env.config.preRequest;
        if (typeof pre === "string") {
          await s.query(`SELECT ${pre.split(".").map(quoteIdent).join(".")}()`);
        } else if (pre) {
          await pre(s, { role, claims, method, path: pathname, request });
        }

        let planned: number | undefined;
        if (plan.planned) {
          const ex = await s.query(`EXPLAIN (FORMAT JSON) ${plan.planned}`);
          const cell = ex[0]?.["QUERY PLAN"];
          const parsed = typeof cell === "string" ? JSON.parse(cell) : cell;
          const n = Number((parsed as any)?.[0]?.Plan?.["Plan Rows"]);
          planned = Number.isFinite(n) ? n : undefined;
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
            throw new PgRestError(400, "PGRST128", "max-affected preference is only valid for functions that return a set", null, null);
          }
          if ((plan.kind === "update" || plan.kind === "delete" || plan.kind === "rpc") && pageTotal > prefer.maxAffected) {
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
      });
    } catch (e) {
      if (e instanceof RollbackWith) return e.value as RawResult;
      // The root table is aliased internally; PostgreSQL error texts should name the real table.
      if (e instanceof DbQueryError && plan.kind !== "rpc" && plan.rel) {
        const fix = (t: string | undefined) => t?.replace(/"pgrst_root"/g, `"${plan.rel!.name}"`).replace(/pgrst_root\./g, `${plan.rel!.name}.`);
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
      if (e instanceof DbQueryError && e.sqlState === "40001" && i < 2) continue;
      throw e;
    }
  }

  return buildResponse(env, request, method, prefer, format, plan, result, honoredTx);
};

// ---------------------------------------------------------------------------
// response
// ---------------------------------------------------------------------------

const buildResponse = (
  env: Env,
  request: Request,
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
    total = max !== undefined && r.planned !== undefined && r.planned > max ? r.planned : plan.countInStatement ? r.total : r.pageTotal;
  }
  const totalStr = total === undefined ? "*" : String(total);

  let status = 200;
  let text = r.body;
  let contentType = JSON_CT;

  if (plan.kind === "read" || (plan.kind === "rpc" && plan.pagedRead !== undefined && (plan.shape === "array" || plan.shape === "object"))) {
    const first = plan.offset;
    const last = plan.offset + r.pageTotal - 1;
    headers["Content-Range"] = r.pageTotal > 0 ? `${first}-${last}/${totalStr}` : `*/${totalStr}`;
    if (total !== undefined && plan.offset > 0 && r.pageTotal === 0 && plan.offset >= total && prefer.count !== "planned") {
      throw new PgRestError(416, "PGRST103", "Requested range not satisfiable", `An offset of ${plan.offset} was requested, but there are only ${total} rows.`, null, {
        "Content-Range": `*/${total}`,
        ...(applied ? { "Preference-Applied": applied } : {}),
      });
    }
    if (total !== undefined && r.pageTotal > 0 && r.pageTotal < total) status = 206;
    if (total !== undefined && r.pageTotal === total && plan.offset > 0) status = 206;
  } else if (plan.kind === "rpc") {
    status = plan.shape === "none" ? 204 : 200;
    headers["Content-Range"] = r.pageTotal > 0 ? `0-${r.pageTotal - 1}/${totalStr}` : `*/${totalStr}`;
  } else {
    if (plan.kind === "update") {
      const n = r.pageTotal;
      headers["Content-Range"] = n > 0 ? `0-${n - 1}/${prefer.count === "exact" ? String(n) : "*"}` : `*/${prefer.count === "exact" ? "0" : "*"}`;
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

  if (format.kind === "csv" && text) {
    text = toCsv(text);
    contentType = "text/csv; charset=utf-8";
  } else if (format.kind === "object") {
    contentType = `application/vnd.pgrst.object+json${format.stripNulls ? ";nulls=stripped" : ""}; charset=utf-8`;
  } else if (format.kind === "json" && format.stripNulls) {
    contentType = "application/vnd.pgrst.array+json;nulls=stripped; charset=utf-8";
  }

  Object.assign(headers, r.responseHeaders);
  if (r.responseStatus !== undefined) status = r.responseStatus;

  const noBody = status === 204 || status === 304 || text === "" || method === "HEAD";
  if (!(status === 204 || status === 304 || (text === "" && method !== "HEAD"))) headers["Content-Type"] = contentType;
  return new Response(noBody ? null : text, { status, headers });
};

export { json as jsonResponse };
