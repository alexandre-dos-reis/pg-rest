import {
  type Caller,
  type Env,
  type Plan,
  type QueryParams,
  type RequestContext,
  assertRole,
  execute,
  planRpc,
  planTable,
  useSchema,
} from "./core";
import { ApiError, PgRestError } from "./errors";
import type { Method, OutputFormat, Preferences } from "./parse/request";
import { toApiError } from "./service";
import type { JsonObject } from "./sql/write";

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

/** A value a filter compares against. */
export type Scalar = string | number | boolean | null;

/** The PostgREST filter operators (https://docs.postgrest.org/en/v16/references/api/tables_views.html#operators). */
export type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "match"
  | "imatch"
  | "in"
  | "is"
  | "isdistinct"
  | "fts"
  | "plfts"
  | "phfts"
  | "wfts"
  | "cs"
  | "cd"
  | "ov"
  | "sl"
  | "sr"
  | "nxl"
  | "nxr"
  | "adj";

/** An operator with its modifiers: `not.`, a quantifier (`eq(any)`) or a text-search config (`fts(english)`). */
export interface FilterSpec {
  readonly op: FilterOp;
  readonly value?: Scalar | ReadonlyArray<Scalar> | undefined;
  /** Invert the operator (`not.eq.1`). */
  readonly not?: boolean | undefined;
  /** Apply the operator to every element of an array column (`eq(any)`). */
  readonly quantifier?: "any" | "all" | undefined;
  /** Text-search configuration: `{ op: "fts", config: "english", value: "cat" }` -> `fts(english).cat`. */
  readonly config?: string | undefined;
}

/**
 * One condition. A plain value means `eq` (and `null` means `is.null`); a tuple is
 * `[operator, value]`; the object form adds the modifiers.
 */
export type Filter = Scalar | readonly [FilterOp, Scalar | ReadonlyArray<Scalar>] | FilterSpec;

/**
 * Conditions on columns, ANDed together, plus the reserved keys `and` and `or` which
 * take a list of nested groups. A key may be a dotted path into an embedded resource
 * (`"orders.total"`), exactly like the query string.
 */
export interface Where {
  readonly [column: string]: Filter | ReadonlyArray<Where> | undefined;
}

/** `"created"`, or the object form for a direction and null placement. */
export type Order =
  | string
  | {
      readonly column: string;
      readonly desc?: boolean | undefined;
      readonly nulls?: "first" | "last" | undefined;
    };

/** Columns to return. A string is a column (`"id"`, `"name->>first"`, `"total::text"`, `"label:name"`). */
export type Select = ReadonlyArray<string | { readonly [relation: string]: Select | Embed }>;

/** An embedded resource, with its own columns, filters, order and paging. */
export interface Embed {
  readonly select?: Select | undefined;
  /** Drop parent rows that have no match (`!inner`). */
  readonly inner?: boolean | undefined;
  /** Merge the embedded columns into the parent row (`...rel(*)`). */
  readonly spread?: boolean | undefined;
  /** Disambiguate the relationship: a foreign key name, or the table to join through. */
  readonly hint?: string | undefined;
  /** Rename the resource in the output (`client:clients(*)`). */
  readonly as?: string | undefined;
  readonly where?: Where | undefined;
  readonly order?: ReadonlyArray<Order> | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** What a write returns: the affected rows, or nothing. */
export type QueryReturning = "representation" | "minimal";

interface Common {
  /** One of the exposed schemas. Defaults to the first one. */
  readonly schema?: string | undefined;
  readonly select?: Select | undefined;
  readonly where?: Where | undefined;
  readonly order?: ReadonlyArray<Order> | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  /** Return one object instead of an array. 0 or 2+ rows is a 406 `PGRST116`, like `vnd.pgrst.object+json`. */
  readonly single?: boolean | undefined;
  /** Also count the matching rows, ignoring paging (`Prefer: count=`). */
  readonly count?: "exact" | "planned" | "estimated" | undefined;
  /** Leave `null` fields out of the result (`nulls=stripped`). */
  readonly stripNulls?: boolean | undefined;
  /** Refuse the call if it would affect more rows than this (`Prefer: max-affected`). */
  readonly maxAffected?: number | undefined;
  /** Run the statement in this time zone (`Prefer: timezone=`). */
  readonly timezone?: string | undefined;
}

/** Read rows from a table or view. */
export interface SelectQuery extends Common {
  readonly table: string;
  readonly action?: "select" | undefined;
}

/** Insert rows, or upsert them with `action: "upsert"`. */
export interface InsertQuery extends Common {
  readonly table: string;
  readonly action: "insert" | "upsert";
  readonly rows: JsonObject | ReadonlyArray<JsonObject>;
  /** Columns the conflict is resolved on (`on_conflict`). Defaults to the primary key. */
  readonly onConflict?: ReadonlyArray<string> | undefined;
  /** Only insert these columns, ignoring any other key in `rows`. */
  readonly columns?: ReadonlyArray<string> | undefined;
  /** What to do with columns missing from `rows`: their `DEFAULT` (the default) or `null`. */
  readonly missing?: "default" | "null" | undefined;
  readonly returning?: QueryReturning | undefined;
}

/** Update the rows matching `where`. */
export interface UpdateQuery extends Common {
  readonly table: string;
  readonly action: "update";
  readonly set: JsonObject;
  readonly returning?: QueryReturning | undefined;
}

/** Delete the rows matching `where`. */
export interface DeleteQuery extends Common {
  readonly table: string;
  readonly action: "delete";
  readonly returning?: QueryReturning | undefined;
}

/** Call a function, like `POST /rpc/name`. `select`, `where` and `order` apply to its result. */
export interface RpcQuery extends Common {
  readonly rpc: string;
  readonly args?: Readonly<Record<string, unknown>> | undefined;
}

export type QueryInput = SelectQuery | InsertQuery | UpdateQuery | DeleteQuery | RpcQuery;

/**
 * What `count` a query gets back from the `count` it asked for. `"exact"` and `"estimated"` always
 * answer with a number -- when paging leaves nothing to count, that number is the page's own length.
 * `"planned"` reads `Plan Rows` out of an `EXPLAIN`, which can come back with nothing usable, so it
 * stays optional. Asking for no count at all gets none: `undefined`, and not a number to test for.
 */
export type CountOf<C> = C extends "exact" | "estimated"
  ? number
  : C extends "planned"
    ? number | undefined
    : C extends undefined
      ? undefined
      : number | undefined;

/** {@link CountOf} read off a query object: a query that never mentions `count` gets none. */
export type CountFrom<Q> = Q extends { count: infer C } ? CountOf<C> : undefined;

/** The half of a {@link QueryResult} a query that worked answers with. */
export interface QueryOk<T = unknown, C extends number | undefined = number | undefined> {
  /** The rows, the single object when `single` is set, or `null` when there is no body. */
  readonly data: T;
  /** Rows matching the filters, ignoring `limit`/`offset`; `undefined` unless `count` asked for one. */
  readonly count: C;
  /** The status the same call would answer with over HTTP (201 after an insert, 204 after a minimal write...). */
  readonly status: number;
  /** Always `null` here: `if (error)` is what separates the two halves. */
  readonly error: null;
}

/** The half a failed query answers with: no data, no count, and the error that explains it. */
export interface QueryFailed {
  readonly data: null;
  readonly count: undefined;
  readonly status: number;
  readonly error: QueryError;
}

/**
 * What a query returned: exactly one of `data` and `error` is set, so `if (error)` leaves `data`
 * non-null and `count` the type the query asked for (see {@link CountOf}).
 */
export type QueryResult<T = unknown, C extends number | undefined = number | undefined> = QueryOk<T, C> | QueryFailed;

/** A query that failed, with the PostgREST error body and the input that produced it. */
export class QueryError extends ApiError {
  constructor(
    readonly input: QueryInput,
    api: ApiError,
    options?: { readonly cause?: unknown },
  ) {
    super({ status: api.status, body: api.body, headers: api.headers });
    this.name = "QueryError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// input -> query parameters
// ---------------------------------------------------------------------------

const OPS: ReadonlySet<string> = new Set<FilterOp>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "match",
  "imatch",
  "in",
  "is",
  "isdistinct",
  "fts",
  "plfts",
  "phfts",
  "wfts",
  "cs",
  "cd",
  "ov",
  "sl",
  "sr",
  "nxl",
  "nxr",
  "adj",
]);

/** Inside a list or a logic tree these read as something other than text, so such a string is quoted. */
const KEYWORDS: ReadonlySet<string> = new Set(["null", "true", "false", "unknown"]);

const bad = (message: string, hint?: string): PgRestError =>
  new PgRestError(400, "PGRST100", message, null, hint ?? null);

/**
 * Render a value the way the query string carries it. A lone value is taken verbatim --
 * `name=eq.a,b` is the text `a,b` and `name=eq.null` is the text `null`, which is why
 * only a *delimited* context (a list or a logic tree, where `,` `)` and `.` separate)
 * needs quoting. `tests/compare` pins both against PostgREST.
 */
const lit = (v: Scalar | undefined, delimited: boolean): string => {
  if (v === undefined || v === null) return "null";
  if (typeof v !== "string") return String(v);
  if (!delimited) return v;
  const quote = v === "" || KEYWORDS.has(v.toLowerCase()) || /[,()[\]{}".\\]/.test(v) || /^\s|\s$/.test(v);
  return quote ? `"${v.replace(/(["\\])/g, "\\$1")}"` : v;
};

/** Array values are a list for `in` and a PostgreSQL array literal for the containment operators. */
const listOf = (op: FilterOp, values: ReadonlyArray<Scalar>): string => {
  const items = values.map((v) => lit(v, true)).join(",");
  return op === "in" ? `(${items})` : `{${items}}`;
};

const toSpec = (column: string, f: Filter): FilterSpec => {
  if (f === null || typeof f !== "object") return { op: "eq", value: f };
  if (Array.isArray(f)) {
    const [op, value] = f as readonly [FilterOp, Scalar | ReadonlyArray<Scalar>];
    if (typeof op !== "string" || !OPS.has(op)) {
      throw bad(
        `Unknown filter operator '${String(op)}' on '${column}'`,
        "A filter is a value, a [operator, value] tuple or { op, value }",
      );
    }
    return { op, value: value as Scalar };
  }
  const spec = f as FilterSpec;
  if (!OPS.has(spec.op)) throw bad(`Unknown filter operator '${String(spec.op)}' on '${column}'`);
  if (spec.quantifier && spec.config) {
    throw bad(`'${column}' cannot have both a quantifier and a text-search configuration`);
  }
  return spec;
};

/** The right-hand side of a filter: `[not.]op[(modifier)].value`. */
const renderFilter = (column: string, f: Filter, delimited: boolean): string => {
  const spec = toSpec(column, f);
  // `col = NULL` is never true in SQL, so comparing with null is a NULL test
  if (spec.value === null && (spec.op === "eq" || spec.op === "neq")) {
    return `${Boolean(spec.not) !== (spec.op === "neq") ? "not." : ""}is.null`;
  }
  const modifier = spec.quantifier ?? spec.config;
  const op = `${spec.not ? "not." : ""}${spec.op}${modifier ? `(${modifier})` : ""}`;
  const value = Array.isArray(spec.value)
    ? listOf(spec.op, spec.value as ReadonlyArray<Scalar>)
    : lit(spec.value as Scalar | undefined, delimited);
  return `${op}.${value}`;
};

const isGroupKey = (key: string): boolean => key === "and" || key === "or";

/** Every condition of a `Where`, rendered as a logic tree would carry them (`total.gte.100`). */
const renderConditions = (w: Where): string[] =>
  Object.entries(w).flatMap(([key, value]) => {
    if (value === undefined) return [];
    if (isGroupKey(key)) {
      if (!Array.isArray(value)) throw bad(`'${key}' takes a list of groups`);
      return [`${key}(${(value as ReadonlyArray<Where>).map(renderGroup).join(",")})`];
    }
    return [`${key}.${renderFilter(key, value as Filter, true)}`];
  });

/** One member of an `and`/`or` list. Several conditions in the same object are ANDed. */
const renderGroup = (w: Where): string => {
  const parts = renderConditions(w);
  if (parts.length === 0) throw bad("An and/or group cannot be empty");
  return parts.length === 1 ? parts[0]! : `and(${parts.join(",")})`;
};

const renderOrder = (o: Order): string => {
  if (typeof o === "string") return o;
  const nulls = o.nulls === "first" ? ".nullsfirst" : o.nulls === "last" ? ".nullslast" : "";
  return `${o.column}${o.desc ? ".desc" : ".asc"}${nulls}`;
};

type Params = Array<[string, string]>;

/** `where`, `order`, `limit` and `offset` of one node, prefixed with its dotted path. */
const pushNode = (
  node: {
    readonly where?: Where | undefined;
    readonly order?: ReadonlyArray<Order> | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  },
  path: ReadonlyArray<string>,
  out: Params,
): void => {
  const at = path.length ? `${path.join(".")}.` : "";
  for (const [key, value] of Object.entries(node.where ?? {})) {
    if (value === undefined) continue;
    if (isGroupKey(key)) {
      if (!Array.isArray(value)) throw bad(`'${key}' takes a list of groups`);
      out.push([`${at}${key}`, `(${(value as ReadonlyArray<Where>).map(renderGroup).join(",")})`]);
    } else {
      // a dotted key filters an embedded resource, and keeps its own path
      out.push([`${at}${key}`, renderFilter(key, value as Filter, false)]);
    }
  }
  if (node.order?.length) out.push([`${at}order`, node.order.map(renderOrder).join(",")]);
  if (node.limit !== undefined) out.push([`${at}limit`, String(node.limit)]);
  if (node.offset !== undefined) out.push([`${at}offset`, String(node.offset)]);
};

const isEmbed = (v: Select | Embed): v is Embed => !Array.isArray(v);

/** The `select` parameter. Embedded resources also push their own filters and paging into `out`. */
const renderSelect = (items: Select, path: ReadonlyArray<string>, out: Params): string => {
  const parts = items.map((item) => {
    if (typeof item === "string") return item;
    return Object.entries(item)
      .map(([relation, spec]) => {
        const embed: Embed = isEmbed(spec) ? spec : { select: spec };
        // filters address an embed by its alias when it has one, like the query string
        const name = embed.as ?? relation;
        const mods = `${embed.hint ? `!${embed.hint}` : ""}${embed.inner ? "!inner" : ""}`;
        const head = `${embed.spread ? "..." : ""}${embed.as ? `${embed.as}:` : ""}${relation}${mods}`;
        const inner = renderSelect(embed.select ?? ["*"], [...path, name], out);
        pushNode(embed, [...path, name], out);
        return `${head}(${inner})`;
      })
      .join(",");
  });
  return parts.join(",");
};

/** Everything the query string would carry, built from the object instead of parsed from a URL. */
export const toParams = (input: QueryInput): Params => {
  const out: Params = [];
  // embedded resources push their own parameters while the select string is built, so collect
  // them aside and keep `select` first, where a reader expects it
  const embedded: Params = [];
  if (input.select) out.push(["select", renderSelect(input.select, [], embedded)]);
  out.push(...embedded);
  pushNode(input, [], out);
  if ("action" in input && (input.action === "insert" || input.action === "upsert")) {
    if (input.onConflict?.length) out.push(["on_conflict", input.onConflict.join(",")]);
    if (input.columns?.length) out.push(["columns", input.columns.join(",")]);
  }
  return out;
};

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

const isRpc = (input: QueryInput): input is RpcQuery => "rpc" in input;

const methodOf = (input: QueryInput): Method => {
  if (isRpc(input)) return "POST";
  switch (input.action ?? "select") {
    case "select":
      return "GET";
    case "insert":
    case "upsert":
      return "POST";
    case "update":
      return "PATCH";
    case "delete":
      return "DELETE";
  }
};

const bodyOf = (input: QueryInput): { kind: string; value: unknown } | undefined => {
  if (isRpc(input)) return { kind: "json", value: input.args ?? {} };
  if (!("action" in input)) return undefined;
  switch (input.action) {
    case "insert":
    case "upsert":
      return { kind: "json", value: input.rows };
    case "update":
      return { kind: "json", value: input.set };
    default:
      return undefined;
  }
};

const writes = (input: QueryInput): boolean => {
  const method = methodOf(input);
  return method !== "GET" && !isRpc(input);
};

/**
 * Unlike HTTP, a write defaults to returning its rows: a function that gives nothing back
 * is of little use in a program. `returning: "minimal"` is PostgREST's own default.
 */
const returningOf = (input: QueryInput): "representation" | "minimal" | undefined => {
  if (!writes(input)) return undefined;
  const asked = (input as InsertQuery | UpdateQuery | DeleteQuery).returning;
  return asked ?? "representation";
};

const preferencesOf = (input: QueryInput): Preferences => ({
  ...(returningOf(input) ? { return: returningOf(input) } : {}),
  ...(input.count ? { count: input.count } : {}),
  ...("action" in input && input.action === "upsert" ? { resolution: "merge-duplicates" as const } : {}),
  ...("action" in input && input.action === "insert" && (input as InsertQuery).missing
    ? { missing: (input as InsertQuery).missing }
    : {}),
  ...(input.maxAffected !== undefined ? { handling: "strict" as const, maxAffected: input.maxAffected } : {}),
  ...(input.timezone ? { timezone: input.timezone } : {}),
  invalid: [],
});

/** The total in a `Content-Range` (`0-9/42`), when one was computed. */
const totalOf = (range: string | null): number | undefined => {
  const total = range?.split("/")[1];
  return total === undefined || total === "*" ? undefined : Number(total);
};

const run = async (env: Env, input: QueryInput, ctx: RequestContext): Promise<Omit<QueryOk, "error">> => {
  assertRole(env, ctx);
  if (isRpc(input) && "table" in input) {
    throw bad("A query names either a table or an rpc, not both");
  }
  const schema = useSchema(env, input.schema);
  const method = methodOf(input);
  const prefer = preferencesOf(input);
  const format: OutputFormat = input.single
    ? { kind: "object", stripNulls: Boolean(input.stripNulls) }
    : { kind: "json", stripNulls: Boolean(input.stripNulls) };
  const qp: QueryParams = { params: toParams(input), bare: new Set<string>() };
  const body = bodyOf(input);

  const plan: Plan = isRpc(input)
    ? planRpc(env, method, schema, input.rpc, qp, prefer, format, undefined, body)
    : planTable(env, method, schema, input.table, qp, prefer, format, undefined, body);

  // SQL reading request.method / request.path sees what the same call over HTTP would show.
  const caller: Caller = { path: isRpc(input) ? `/rpc/${input.rpc}` : `/${input.table}` };
  const res = await execute(env, ctx, caller, method, schema, prefer, format, plan, false, undefined);

  const text = await res.text();
  return {
    data: text === "" ? null : (JSON.parse(text) as unknown),
    count: totalOf(res.headers.get("content-range")),
    status: res.status,
  };
};

/**
 * Run a query described by an object, in-process. Same parser, same SQL and same errors as
 * {@link handleRequest}: only the HTTP envelope is gone.
 *
 * **This never rejects.** Every failure, including one the library did not foresee, comes back as
 * the `error` of the result, so a caller that checks it needs no `try`/`catch` at all.
 */
export const runQuery = async (env: Env, input: QueryInput, ctx: RequestContext = {}): Promise<QueryResult> => {
  try {
    return { ...(await run(env, input, ctx)), error: null };
  } catch (e) {
    const api = toApiError(e, ctx.role ?? env.config.anonymousRole, env.config.anonymousRole);
    // An unexpected error keeps its stack under `cause`; over HTTP it would only be a 500 body.
    const unexpected = api.status >= 500 && !(e instanceof PgRestError) && !(e instanceof ApiError);
    return toFailedResult(input, new QueryError(input, api, unexpected ? { cause: e } : undefined));
  }
};

/**
 * Turn anything at all into the failed half of a {@link QueryResult}. `runQuery` maps what it can;
 * whatever it could not still arrives, as the body PostgREST answers a 500 with and the original
 * error under `cause`. Nothing is logged and nothing is dropped: `error` is the only channel, so
 * the caller decides what to do with it.
 */
export const toFailedResult = (input: QueryInput, e: unknown): QueryFailed => {
  const error =
    e instanceof QueryError
      ? e
      : new QueryError(
          input,
          new ApiError({
            status: 500,
            headers: {},
            body: { code: "PGRSTX00", message: "Internal error", details: null, hint: null },
          }),
          { cause: e },
        );
  return { data: null, count: undefined, status: error.status, error };
};
