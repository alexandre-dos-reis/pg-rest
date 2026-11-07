import type { DbSession } from "@tsql/core/adapter";
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
  transactionSetup,
  useSchema,
} from "@tsql/core/core";
import {
  ApiError,
  DbQueryError,
  PgRestError,
  type QueryErrorKind,
  describeErrorKind,
  errorKind,
} from "@tsql/core/errors";
import type { Operator } from "@tsql/core/parse/filter";
import { FTS_ORDER, OPERATORS_ORDER } from "@tsql/core/parse/syntax";
import { getRelation } from "@tsql/core/schema";
import { compileSet } from "@tsql/core/sql/expression";
import { ROOT_ALIAS } from "@tsql/core/sql/read";
import type { Method, OutputFormat, Preferences } from "@tsql/core/parse/request";
import { toApiError } from "@tsql/core/service";
import type { JsonObject } from "@tsql/core/sql/write";

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

/** A value a filter compares against. */
export type Scalar = string | number | boolean | null;

/**
 * A value of a [composite type](https://www.postgresql.org/docs/current/rowtypes.html): its fields
 * by name, nested composites and arrays included. It travels as JSON and is turned into a row of
 * the column's own type, so the fields may come in any order and a missing one is NULL.
 *
 * An object is read as a composite value unless its keys all start with `$` -- that is what tells
 * it from an {@link OperatorSpec}. A composite type with a field whose name starts with `$`
 * therefore cannot use this form; pass the JSON yourself, as a string.
 */
export interface CompositeValue {
  readonly [field: string]: Scalar | CompositeValue | ReadonlyArray<Scalar | CompositeValue> | undefined;
}

/** What an operator compares a column against. */
export type FilterValue = Scalar | CompositeValue;

/**
 * The PostgREST filter operators (https://docs.postgrest.org/en/v16/references/api/tables_views.html#operators).
 * The same type the parser works with, from the one list in `parse/syntax.ts`.
 */
export type FilterOp = Operator;

/** The full-text search operators, which take a text-search configuration. */
export type FtsOp = (typeof FTS_ORDER)[number];

/** A text-search query with its configuration: `{ $fts: { query: "cat", config: "english" } }`. */
export interface FtsValue {
  readonly query: string;
  readonly config?: string | undefined;
}

/** What an operator is given: one value, or a list (for `$in`, and for the array operators). */
export type OperatorValue = FilterValue | ReadonlyArray<FilterValue>;

/** The modifiers, each wrapping exactly one operator: `{ $not: { $eq: 1 } }`, `{ $any: { $eq: 1 } }`. */
export interface OperatorModifiers {
  /** Invert the operator (`not.eq.1`), or a plain value, which means `eq`: `{ $not: null }` is `not.is.null`. */
  readonly $not?: OperatorSpec | Scalar | CompositeValue | undefined;
  /** Compare with some value of a list (`like(any)`): `{ $any: { $like: ["a*", "b*"] } }`. */
  readonly $any?: OperatorSpec | undefined;
  /** Compare with every value of a list (`like(all)`), written like `$any`. */
  readonly $all?: OperatorSpec | undefined;
}

/**
 * The conditions on one column, by operator: `{ $gte: 100, $lt: 500 }` is `>= 100 AND < 500`. Every
 * key starts with `$`.
 */
export type OperatorSpec = {
  readonly [K in Exclude<FilterOp, FtsOp> as `$${K}`]?: OperatorValue | undefined;
} & {
  readonly [K in FtsOp as `$${K}`]?: string | FtsValue | undefined;
} & OperatorModifiers;

/**
 * One condition. A plain value means `eq` (and `null` means `is.null`); an object whose keys all
 * start with `$` names the operators; any other object is a {@link CompositeValue} compared with
 * `eq`. To compare with an array, say so: `{ $eq: ["a", "b"] }`.
 */
export type Filter = Scalar | CompositeValue | OperatorSpec;

/**
 * Conditions on columns, ANDed together, plus the reserved keys `$and` and `$or`, which take a list
 * of nested groups, and `$not`, which takes one group and inverts it. A key may be a dotted path
 * into an embedded resource (`"orders.total"`), exactly like the query string.
 */
export interface Where {
  readonly [column: string]: Filter | ReadonlyArray<Where> | Where | undefined;
}

// ---------------------------------------------------------------------------
// expressions (the `set` of an update)
// ---------------------------------------------------------------------------

type NaryKey =
  | "$add"
  | "$sub"
  | "$mul"
  | "$div"
  | "$mod"
  | "$pow"
  | "$concat"
  | "$and"
  | "$or"
  | "$coalesce"
  | "$greatest"
  | "$least";
type UnaryFunctionKey = "$lower" | "$upper" | "$trim" | "$length" | "$abs";
type BinaryKey = "$eq" | "$neq" | "$gt" | "$gte" | "$lt" | "$lte" | "$cs" | "$cd" | "$ov";

/**
 * A value computed by the database, in `set`. Every node is an object with exactly one `$` key; a
 * number, boolean, string or `null` is a literal (a string is never a column: use `$col`).
 *
 * - `{ $col: "total" }` is a column of the row being updated, `{ $val: x }` any JSON value as a literal.
 * - `{ $add: [a, b] }` and the other operators are PostgreSQL's (`+ - * / % ^ || = <> > >= < <= @> <@ &&`,
 *   `AND`, `OR`, `NOT`), on the types they work on: `$concat` appends to an array, merges `jsonb` and joins text.
 * - `{ $cast: [expression, "numeric"] }`, `{ $coalesce: [a, b] }`, `$greatest`, `$least`.
 * - A fixed list of functions: `{ $now: true }`, `$lower`, `$upper`, `$trim`, `$length`, `$abs`, `$round`,
 *   `$arrayAppend` and `$arrayRemove`. There is no way to call another one.
 */
export type Expression =
  | Scalar
  | { readonly $col: string }
  | { readonly $val: unknown }
  | { readonly $cast: readonly [Expression, string] }
  | { readonly $not: Expression }
  | { readonly $neg: Expression }
  | { readonly $now: true }
  | { readonly [K in UnaryFunctionKey]: { readonly [P in K]: Expression } }[UnaryFunctionKey]
  | { readonly $round: readonly [Expression] | readonly [Expression, number] }
  | { readonly [K in "$arrayAppend" | "$arrayRemove"]: { readonly [P in K]: readonly [Expression, Expression] } }[
      | "$arrayAppend"
      | "$arrayRemove"]
  | { readonly [K in NaryKey]: { readonly [P in K]: ReadonlyArray<Expression> } }[NaryKey]
  | { readonly [K in BinaryKey]: { readonly [P in K]: readonly [Expression, Expression] } }[BinaryKey];

/** `{ $default: true }`: the column's `DEFAULT`, as a whole assignment. */
export interface DefaultValue {
  readonly $default: true;
}

/**
 * The columns an update changes, and only those: the keys are the columns of the table. A plain value
 * is PostgREST's own `PATCH` body; an {@link Expression} or {@link DefaultValue} computes it in the
 * database. An object whose keys all start with `$` is an expression -- to store a `jsonb` value like
 * that, wrap it in `{ $val: … }`. The expressions are only available through `query()`.
 */
export interface SetInput {
  readonly [column: string]: unknown;
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

/**
 * The filters, order and paging one node of a query takes: its root, and every embedded resource.
 * They are rendered by the same code, prefixed with the node's dotted path.
 */
export interface NodeFields {
  readonly where?: Where | undefined;
  readonly order?: ReadonlyArray<Order> | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** An embedded resource, with its own columns, filters, order and paging. */
export interface Embed extends NodeFields {
  readonly select?: Select | undefined;
  /** Drop parent rows that have no match (`!inner`). */
  readonly inner?: boolean | undefined;
  /** Merge the embedded columns into the parent row (`...rel(*)`). */
  readonly spread?: boolean | undefined;
  /** Disambiguate the relationship: a foreign key name, or the table to join through. */
  readonly hint?: string | undefined;
  /** Rename the resource in the output (`client:clients(*)`). */
  readonly as?: string | undefined;
}

/** What a write returns: the affected rows, or nothing. */
export type QueryReturning = "representation" | "minimal";

interface Common extends NodeFields {
  /** One of the exposed schemas. Defaults to the first one. */
  readonly schema?: string | undefined;
  readonly select?: Select | undefined;
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
  readonly set: SetInput;
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

/** The resource a query names, as it would read in a sentence: `select on "api.clients"`. */
const operationOf = (input: QueryInput): string => {
  if (input === TRANSACTION) return "transaction";
  const at = input.schema ? `${input.schema}.` : "";
  if ("rpc" in input) return `rpc "${at}${input.rpc}"`;
  const target = "table" in input ? `"${at}${input.table}"` : "the database";
  return `${input.action ?? "select"} on ${target}`;
};

/**
 * The failure written out for a person: what was attempted, what the database or the parser said,
 * what to do about it, and the classification last -- so the first line alone is useful in a log
 * that cuts the rest off.
 */
const explain = (input: QueryInput, api: ApiError, kind: QueryErrorKind): string =>
  [
    `${operationOf(input)} failed: ${api.body.message || describeErrorKind(kind)}`,
    api.body.details ? `  details: ${api.body.details}` : "",
    api.body.hint ? `  hint: ${api.body.hint}` : "",
    `  kind: ${kind} -- ${describeErrorKind(kind)} (${api.body.code}, HTTP ${api.status})`,
  ]
    .filter(Boolean)
    .join("\n");

/** A query that failed, with the PostgREST error body and the input that produced it. */
export class QueryError extends ApiError {
  /**
   * What went wrong, as one string out of a closed union: the thing to `switch` on. The exact
   * reason stays in `body.code`; this is the handful of cases that call for different reactions.
   */
  readonly kind: QueryErrorKind;

  /**
   * The same failure written out for whoever reads the log: the call it came from, then what the
   * database or the parser said, then `details`, `hint` and the kind, each on its own line.
   *
   * `message` is left as it is -- one line, prefixed with the code, the summary `ApiError` builds
   * for a response -- because something somewhere reads it, and a multi-line `Error.message` is
   * not what a log collector expects. This is the readable form, and it is opt-in.
   */
  readonly summary: string;

  constructor(
    readonly input: QueryInput,
    api: ApiError,
    options?: { readonly cause?: unknown },
  ) {
    super({ status: api.status, body: api.body, headers: api.headers });
    this.name = "QueryError";
    this.kind = errorKind(api.status, api.body.code);
    // a caller of query() holds the input too, which is what lets the explanation name the call
    this.summary = explain(input, api, this.kind);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// input -> query parameters
// ---------------------------------------------------------------------------

const OPS: ReadonlySet<string> = new Set<FilterOp>(OPERATORS_ORDER);

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
const lit = (v: FilterValue | undefined, delimited: boolean): string => {
  if (v === undefined || v === null) return "null";
  // a composite value travels as JSON, which `valueSql` turns into a row of the column's type
  if (typeof v === "object") return lit(JSON.stringify(v), delimited);
  if (typeof v !== "string") return String(v);
  if (!delimited) return v;
  const quote = v === "" || KEYWORDS.has(v.toLowerCase()) || /[,()[\]{}".\\]/.test(v) || /^\s|\s$/.test(v);
  return quote ? `"${v.replace(/(["\\])/g, "\\$1")}"` : v;
};

/** Array values are a list for `in` and a PostgreSQL array literal for the containment operators. */
const listOf = (op: FilterOp, values: ReadonlyArray<FilterValue>): string => {
  const items = values.map((v) => lit(v, true)).join(",");
  return op === "in" ? `(${items})` : `{${items}}`;
};

/** One condition on a column, once its modifiers are resolved: `[not.]op[(modifier)].value`. */
interface Leaf {
  readonly op: FilterOp;
  readonly value: OperatorValue | undefined;
  readonly not: boolean;
  readonly quantifier?: "any" | "all";
  readonly config?: string;
}

const FTS_OPS: ReadonlySet<string> = new Set(FTS_ORDER);

/** What a `{ op, value, ... }` object from the former syntax looks like. */
const LEGACY_KEYS: ReadonlySet<string> = new Set(["op", "value", "not", "quantifier", "config"]);

const isSpecKey = (k: string): boolean => k.startsWith("$");

/** An object whose keys all start with `$` names operators; `undefined` for any other object. */
const isOperatorSpec = (column: string, f: object): boolean => {
  const keys = Object.keys(f);
  const marked = keys.filter(isSpecKey).length;
  if (marked === 0) return false;
  if (marked < keys.length) {
    throw bad(
      `'${column}' mixes operators and fields: ${keys.join(", ")}`,
      "Keys starting with $ are operators; an object with none is a composite value",
    );
  }
  return true;
};

/** The one leaf a modifier wraps. */
const single = (column: string, modifier: string, inner: OperatorSpec): Leaf => {
  const leaves = leavesOf(column, inner);
  if (leaves.length !== 1) throw bad(`'${modifier}' on '${column}' takes exactly one operator`);
  return leaves[0]!;
};

const leavesOf = (column: string, spec: OperatorSpec): Leaf[] => {
  const entries = Object.entries(spec).filter(([, v]) => v !== undefined);
  if (entries.length === 0) throw bad(`'${column}' has no operator`);
  return entries.map(([key, value]): Leaf => {
    if (key === "$not") {
      // a plain value is an `eq`, the way it is outside of `$not`
      const plain = value === null || typeof value !== "object" || !isOperatorSpec(column, value);
      const inner = plain ? toLeaves(column, value as Filter)[0]! : single(column, key, value as OperatorSpec);
      return { ...inner, not: !inner.not };
    }
    if (key === "$any" || key === "$all") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw bad(
          `'${key}' on '${column}' wraps an operator`,
          `Write { ${key}: { $eq: [...] } }; $in is the same for eq`,
        );
      }
      const inner = single(column, key, value as OperatorSpec);
      if (inner.not || inner.quantifier || inner.config) {
        throw bad(
          `'${key}' on '${column}' wraps a bare operator`,
          "Put $not around the quantifier instead: { $not: { $any: { $eq: 1 } } }",
        );
      }
      return { ...inner, quantifier: key === "$any" ? "any" : "all" };
    }
    const op = key.slice(1) as FilterOp;
    if (!isSpecKey(key) || !OPS.has(op)) {
      throw bad(`Unknown filter operator '${key}' on '${column}'`, "An operator is written $eq, $gte, $ilike, ...");
    }
    if (FTS_OPS.has(op) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const { query, config } = value as FtsValue;
      return { op, value: query, not: false, ...(config ? { config } : {}) };
    }
    return { op, value: value as OperatorValue, not: false };
  });
};

const toLeaves = (column: string, f: Filter): Leaf[] => {
  if (f === null || typeof f !== "object") return [{ op: "eq", value: f, not: false }];
  if (Array.isArray(f)) {
    throw bad(
      `'${column}' is compared with an array`,
      "A filter is a value or an object of operators; to compare with an array, write { $eq: [...] }",
    );
  }
  if (isOperatorSpec(column, f)) return leavesOf(column, f as OperatorSpec);
  // `{ op: "gte", value: 1 }` was the former syntax: say so rather than compare with that object
  const keys = Object.keys(f);
  const op = (f as { op?: unknown }).op;
  if (typeof op === "string" && OPS.has(op) && keys.every((k) => LEGACY_KEYS.has(k))) {
    throw bad(`'${column}' uses the former { op, value } syntax`, `Write { $${op}: value } instead`);
  }
  return [{ op: "eq", value: f as CompositeValue, not: false }];
};

/** The right-hand side of one leaf: `[not.]op[(modifier)].value`. */
const renderLeaf = (leaf: Leaf, delimited: boolean): string => {
  // `col = NULL` is never true in SQL, so comparing with null is a NULL test
  if (leaf.value === null && (leaf.op === "eq" || leaf.op === "neq")) {
    return `${leaf.not !== (leaf.op === "neq") ? "not." : ""}is.null`;
  }
  if (leaf.quantifier && leaf.config)
    throw bad("A filter cannot have both a quantifier and a text-search configuration");
  const modifier = leaf.quantifier ?? leaf.config;
  const op = `${leaf.not ? "not." : ""}${leaf.op}${modifier ? `(${modifier})` : ""}`;
  const value = Array.isArray(leaf.value)
    ? listOf(leaf.op, leaf.value as ReadonlyArray<FilterValue>)
    : lit(leaf.value as FilterValue | undefined, delimited);
  return `${op}.${value}`;
};

/** The conditions on one column, as many as it has operators. */
const renderFilters = (column: string, f: Filter, delimited: boolean): string[] =>
  toLeaves(column, f).map((leaf) => renderLeaf(leaf, delimited));

/** The logic-tree keys, by the name the query string gives them. */
const GROUPS: Readonly<Record<string, string>> = { $and: "and", $or: "or", $not: "not.and" };

const isGroupKey = (key: string): boolean => key in GROUPS;

/** The members of a group: a list for `$and`/`$or`, one `Where` for `$not`. */
const groupMembers = (key: string, value: unknown): ReadonlyArray<Where> => {
  if (key === "$not") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw bad("'$not' takes one group of conditions");
    return [value as Where];
  }
  if (!Array.isArray(value)) throw bad(`'${key}' takes a list of groups`);
  return value as ReadonlyArray<Where>;
};

/** `name(member,member)`: a `$not` group is the AND of its conditions, inverted. */
const renderGroupTree = (key: string, value: unknown): string => {
  const members = groupMembers(key, value);
  const inner = key === "$not" ? renderConditions(members[0]!) : members.map(renderGroup);
  if (key === "$not" && inner.length === 0) throw bad("A $not group cannot be empty");
  return `(${inner.join(",")})`;
};

/** A key that is neither a column nor a group. */
const checkKey = (key: string): void => {
  if (isSpecKey(key) && !isGroupKey(key)) {
    throw bad(`Unknown key '${key}' in where`, "Only $and, $or and $not are reserved; a column is named without a $");
  }
};

/** Every condition of a `Where`, rendered as a logic tree would carry them (`total.gte.100`). */
const renderConditions = (w: Where): string[] =>
  Object.entries(w).flatMap(([key, value]) => {
    if (value === undefined) return [];
    checkKey(key);
    if (isGroupKey(key)) return [`${GROUPS[key]}${renderGroupTree(key, value)}`];
    return renderFilters(key, value as Filter, true).map((f) => `${key}.${f}`);
  });

/** One member of an `$and`/`$or` list. Several conditions in the same object are ANDed. */
const renderGroup = (w: Where): string => {
  const parts = renderConditions(w);
  if (parts.length === 0) throw bad("An $and/$or group cannot be empty");
  return parts.length === 1 ? parts[0]! : `and(${parts.join(",")})`;
};

const renderOrder = (o: Order): string => {
  if (typeof o === "string") return o;
  const nulls = o.nulls === "first" ? ".nullsfirst" : o.nulls === "last" ? ".nullslast" : "";
  return `${o.column}${o.desc ? ".desc" : ".asc"}${nulls}`;
};

type Params = Array<[string, string]>;

/** `where`, `order`, `limit` and `offset` of one node, prefixed with its dotted path. */
const pushNode = (node: NodeFields, path: ReadonlyArray<string>, out: Params): void => {
  const at = path.length ? `${path.join(".")}.` : "";
  for (const [key, value] of Object.entries(node.where ?? {})) {
    if (value === undefined) continue;
    checkKey(key);
    if (isGroupKey(key)) {
      out.push([`${at}${GROUPS[key]}`, renderGroupTree(key, value)]);
    } else {
      // a dotted key filters an embedded resource, and keeps its own path
      for (const f of renderFilters(key, value as Filter, false)) out.push([`${at}${key}`, f]);
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
  let qp: QueryParams = { params: toParams(input), bare: new Set<string>() };
  let body = bodyOf(input);
  if (!isRpc(input) && "action" in input && input.action === "update") {
    // the expressions of `set` are an extension of PostgREST's PATCH: compiled here, the plain values stay the JSON body
    const set = compileSet(input.set, getRelation(env.cache, schema, input.table), ROOT_ALIAS);
    body = { kind: "json", value: set.plain };
    qp = { ...qp, setClauses: set.clauses };
  }

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
    return failureOf(env, ctx, input, e);
  }
};

/**
 * Map anything thrown into the failed half of a result, the way `query()` does: a `QueryError`
 * keeps the input it already names, a `PgRestError` keeps its status and body, and anything else
 * becomes a 500 with the original under `cause`.
 */
const failureOf = (env: Env, ctx: RequestContext, input: QueryInput, e: unknown): QueryFailed => {
  if (e instanceof QueryError) return toFailedResult(e.input, e);
  const api = toApiError(e, ctx.role ?? env.config.anonymousRole, env.config.anonymousRole);
  // An unexpected error keeps its stack under `cause`; over HTTP it would only be a 500 body.
  const unexpected = api.status >= 500 && !(e instanceof PgRestError) && !(e instanceof ApiError);
  return toFailedResult(input, new QueryError(input, api, unexpected ? { cause: e } : undefined));
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

// ---------------------------------------------------------------------------
// an implicit context
// ---------------------------------------------------------------------------

/**
 * Where a bound query reads its context from: a fixed one, or a function called at every call --
 * which is what makes it work with an `AsyncLocalStorage`, a per-request store or anything else
 * that answers "who is asking" for the task in flight.
 */
export type ContextSource = RequestContext | (() => RequestContext | undefined | Promise<RequestContext | undefined>);

/**
 * `query` with its context already decided. Passing one anyway overrides the source for that call,
 * which is how an administrative call escapes the ambient context without leaving it.
 *
 * It is callable, and it carries `transaction`: a scope is the other place application code runs a
 * query, and it reads the same source -- once, on entry, because the transaction has one
 * `set_config`.
 */
export interface ContextQuery {
  <T = unknown>(input: QueryInput, ctx?: RequestContext): Promise<QueryResult<T>>;
  /**
   * {@link runTransaction} with the context read from the source. Naming a `role`, `claims` or
   * `settings` in `options` overrides the ambient context for the whole transaction, exactly as a
   * context passed to a call overrides it for one query; the scope's own options alone leave it in
   * place. Another role means another transaction.
   */
  transaction<A>(fn: (tx: Transaction) => Promise<A>, options?: TransactionOptions): Promise<QueryResult<A, undefined>>;
}

/**
 * A context source that came back with nothing: the store was never entered (a job, a test, a
 * middleware that did not run). It is an error and not a fall back to the anonymous role, because
 * silently dropping privileges is the kind of thing a query should refuse rather than guess.
 */
export const noContextResult = (input: QueryInput): QueryFailed =>
  toFailedResult(
    input,
    new QueryError(
      input,
      new ApiError({
        status: 500,
        headers: {},
        body: {
          code: "PGRSTX01",
          message: "No request context",
          details: "The context source of setContextQuery() returned nothing",
          hint: "Run the query inside the scope that provides it, or pass a context as the second argument",
        },
      }),
    ),
  );

/** Resolve a {@link ContextSource} for one call; `undefined` means it had nothing to give. */
export const resolveContextSource = async (source: ContextSource): Promise<RequestContext | undefined> =>
  typeof source === "function" ? await source() : source;

// ---------------------------------------------------------------------------
// a transaction across several queries
// ---------------------------------------------------------------------------

/**
 * When a scope may be replayed. A serialization failure (`40001`) or a deadlock (`40P01`) means the
 * whole transaction rolled back, so running it again is sound -- but running it again means running
 * **your callback** again, with whatever else it does. Hence off by default, and asked for here.
 */
export interface TransactionRetry {
  /** How many times the callback may run in all. `1` (the default) is no retry; `3` means two replays. */
  readonly attempts?: number | undefined;
  /** The SQLSTATEs worth replaying. Default `["40001"]`; add `"40P01"` for deadlocks. */
  readonly on?: ReadonlyArray<string> | undefined;
  /** Wait this long before a replay. Default `0`. */
  readonly delayMs?: number | undefined;
}

/**
 * The [isolation level](https://www.postgresql.org/docs/current/transaction-iso.html) a scope runs
 * at, lower-cased as PostgreSQL spells it. `read uncommitted` is not here on purpose: PostgreSQL
 * accepts it and runs `read committed` anyway, so it would be a synonym pretending to be a level.
 *
 * Above `read committed`, a concurrent write can abort the transaction with a serialization failure
 * (`40001`) that retrying is the remedy for -- which is what {@link TransactionRetry} is.
 */
export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

/**
 * What a scope takes: who is asking -- the same `role`, `claims` and `settings` as a single query,
 * applied once for all of it -- and the three things that belong to a transaction rather than to a
 * statement.
 */
export interface TransactionOptions extends RequestContext {
  /** `SET TRANSACTION READ ONLY` for the whole scope. A write inside it is refused by PostgreSQL (`25006`). */
  readonly readOnly?: boolean | undefined;
  /** The isolation level for the whole scope. Default: the database's own (`read committed` unless configured otherwise). */
  readonly isolationLevel?: IsolationLevel | undefined;
  /** Replay the callback on a serialization failure. Off by default: see {@link TransactionRetry}. */
  readonly retry?: TransactionRetry | undefined;
}

/**
 * One transaction, several queries. `query` is {@link runQuery} minus its context: the role and the
 * claims were set with `set_config(..., true)` once at the head of the transaction, and re-issuing
 * them halfway through would change the role for every statement that follows instead of scoping
 * anything -- so a context here is a type error rather than an argument quietly ignored.
 */
export interface Transaction {
  /**
   * Run a query in this transaction: same parser, same SQL, same errors as `query()`. What differs
   * is the failure, and for one reason -- a query that failed is a transaction that will not
   * commit, so there is nothing for the rest of the callback to do with it.
   *
   * It **rejects** instead of answering an `error`, which is what makes the result the success:
   * `data` is not null, `count` is the number the query asked for, and nothing has to be narrowed.
   * `transaction()` catches it, rolls the transaction back and hands it to you as its own `error`,
   * so the promise that does not reject is still there -- it is the scope's now, not the query's.
   *
   * ```ts ignore
   * const { data, count } = await tx.query({ table: "todos", select: ["id"], count: "exact" });
   * ```
   *
   * To *look* at a failure rather than leave on it, use {@link Transaction.transaction}: a savepoint
   * is the only place a transaction can carry on after one.
   */
  query<T = unknown, C extends number | undefined = number | undefined>(input: QueryInput): Promise<QueryOk<T, C>>;
  /**
   * A nested scope, on a `SAVEPOINT`: it rolls back on its own when it fails, leaving the
   * transaction around it usable. That is how one query is allowed to fail inside a scope -- and
   * unlike `query`, this answers a {@link QueryResult} rather than rejecting, because here the
   * failure is recoverable: the savepoint undid it, and the enclosing scope decides what next.
   */
  transaction<A>(fn: (tx: Transaction) => Promise<A>): Promise<QueryResult<A, undefined>>;
  /** Roll this scope back and leave it: the savepoint for a nested one, the transaction otherwise. */
  rollback(): never;
}

/**
 * The input a scope-level failure names: there is no one query to blame when the callback threw,
 * when `rollback()` was called or when the context source answered nothing. Compared by identity,
 * so `operationOf` can say "transaction" instead of inventing a table.
 */
const TRANSACTION = Object.freeze({ table: "", action: "select" }) as QueryInput;

/** `tx.rollback()`: not a failure to map, a decision to carry out. */
class RollbackSignal extends Error {
  constructor() {
    super("rollback");
    this.name = "RollbackSignal";
  }
}

/** Carries a decided result out through the driver's callback, which is what makes it roll back. */
class AbortScope extends Error {
  constructor(readonly failed: QueryFailed) {
    super("transaction rolled back");
    this.name = "AbortScope";
  }
}

const scopeError = (code: string, message: string, details: string | null, hint: string | null): QueryError =>
  new QueryError(TRANSACTION, new ApiError({ status: 500, headers: {}, body: { code, message, details, hint } }));

const scopeFailure = (code: string, message: string, details: string | null, hint: string | null): QueryFailed =>
  toFailedResult(TRANSACTION, scopeError(code, message, details, hint));

/** The first failure in a scope: it cannot commit any more, and says so rather than answering `25P02`. */
interface ScopeState {
  failed?: QueryError | undefined;
}

/** What a scope's callback left behind: a value to commit on, or the failure to roll back for. */
type Outcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly failed: QueryFailed };

const okResult = <A>(value: A): QueryResult<A, undefined> => ({
  data: value,
  count: undefined,
  status: 200,
  error: null,
});

/**
 * Run `fn` against a scope on `env.session` and classify what came out of it. Nothing here touches
 * the transaction: the caller decides whether that is a `COMMIT`, a `ROLLBACK` or a savepoint.
 */
const runScope = async <A>(
  env: Env,
  ctx: RequestContext,
  names: { n: number },
  fn: (tx: Transaction) => Promise<A>,
): Promise<Outcome<A>> => {
  const state: ScopeState = {};
  const session = env.session!;

  // Reachable by catching what `tx.query` throws and carrying on: PostgreSQL has aborted the
  // transaction, so the next statement answers `25P02` whatever it is. Saying so, with the way out,
  // beats passing that on -- and the scope cannot commit either way.
  const refused = (): QueryError =>
    scopeError(
      "PGRSTX03",
      "Transaction already failed",
      `An earlier query in this transaction failed (${state.failed!.body.code}), so it will roll back`,
      "Wrap the queries allowed to fail in tx.transaction(), which runs them in a savepoint of their own",
    );

  const tx: Transaction = {
    query: async <T = unknown, C extends number | undefined = number | undefined>(
      input: QueryInput,
    ): Promise<QueryOk<T, C>> => {
      if (state.failed) throw refused();
      const result = (await runQuery(env, input, ctx)) as QueryResult<T, C>;
      // A failure the library raised to undo its own write (PGRST116, PGRST124) did not abort
      // anything by itself, so the scope records it before leaving: `error` must not come back
      // from a transaction that kept the row, whatever the callback does next.
      if (result.error) {
        state.failed = result.error;
        throw result.error;
      }
      return result;
    },

    transaction: async <B>(nested: (tx: Transaction) => Promise<B>): Promise<QueryResult<B, undefined>> => {
      if (state.failed) return toFailedResult(TRANSACTION, refused()) as QueryResult<B, undefined>;
      const name = `pgrst_sp_${++names.n}`;
      const broke = (e: unknown): QueryResult<B, undefined> => {
        // The savepoint machinery itself failed: the enclosing scope cannot be trusted either.
        const failed = failureOf(env, ctx, TRANSACTION, e);
        state.failed = failed.error;
        return failed as QueryResult<B, undefined>;
      };
      try {
        await session.query(`SAVEPOINT ${name}`);
      } catch (e) {
        return broke(e);
      }
      const outcome = await runScope<B>(env, ctx, names, nested);
      try {
        if (!outcome.ok) await session.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await session.query(`RELEASE SAVEPOINT ${name}`);
      } catch (e) {
        return broke(e);
      }
      return outcome.ok ? okResult(outcome.value) : (outcome.failed as QueryResult<B, undefined>);
    },

    rollback: (): never => {
      throw new RollbackSignal();
    },
  };

  try {
    const value = await fn(tx);
    // The callback returned, but a query in it failed and the transaction is not committable.
    if (state.failed) return { ok: false, failed: toFailedResult(state.failed.input, state.failed) };
    return { ok: true, value };
  } catch (e) {
    if (e instanceof RollbackSignal) {
      return {
        ok: false,
        failed: scopeFailure("PGRSTX02", "Transaction rolled back", "rollback() was called in the scope", null),
      };
    }
    return { ok: false, failed: failureOf(env, ctx, TRANSACTION, e) };
  }
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One scope, one transaction: the context applied once for all of it, a commit when the callback
 * returns, a rollback when it throws **or** when any query in it failed.
 *
 * Answers a {@link QueryResult} around whatever the callback returned -- `data` is that value,
 * there is no `count` -- and never rejects, like `query()`.
 */
export const runTransaction = async <A>(
  env: Env,
  fn: (tx: Transaction) => Promise<A>,
  options: TransactionOptions = {},
): Promise<QueryResult<A, undefined>> => {
  const { readOnly, isolationLevel, retry, ...ctx } = options;
  // One statement, and it has to be the first one: PostgreSQL refuses either of these (`25001`)
  // once the transaction has issued anything. The levels are a closed union, so they go in as text.
  const mode = [isolationLevel ? `ISOLATION LEVEL ${isolationLevel.toUpperCase()}` : "", readOnly ? "READ ONLY" : ""]
    .filter(Boolean)
    .join(" ");
  try {
    assertRole(env, ctx);
  } catch (e) {
    return failureOf(env, ctx, TRANSACTION, e) as QueryResult<A, undefined>;
  }
  const attempts = Math.max(1, Math.trunc(retry?.attempts ?? 1));
  const replayable = new Set(retry?.on ?? ["40001"]);

  for (let attempt = 1; ; attempt++) {
    const again = (code: string): boolean => attempt < attempts && replayable.has(code);
    try {
      return await env.db.transaction(async (session: DbSession) => {
        const scoped: Env = { ...env, session };
        if (mode) await session.query(`SET TRANSACTION ${mode}`);
        const setup = transactionSetup(scoped, ctx);
        await session.query(setup.sql, setup.params);
        const outcome = await runScope<A>(scoped, ctx, { n: 0 }, fn);
        // Throwing is how the driver is told to roll back; the result rides along.
        if (!outcome.ok) throw new AbortScope(outcome.failed);
        return okResult(outcome.value);
      });
    } catch (e) {
      if (e instanceof AbortScope) {
        if (again(e.failed.error.body.code)) {
          if (retry?.delayMs) await wait(retry.delayMs);
          continue;
        }
        return e.failed as QueryResult<A, undefined>;
      }
      // The `COMMIT` itself can fail this way, and it is the driver that issues it.
      if (e instanceof DbQueryError && again(e.sqlState)) {
        if (retry?.delayMs) await wait(retry.delayMs);
        continue;
      }
      return failureOf(env, ctx, TRANSACTION, e) as QueryResult<A, undefined>;
    }
  }
};

/** A scope that failed before the `BEGIN`, or outside everything `runTransaction` can map. */
export const failedTransaction = (e: unknown): QueryFailed => toFailedResult(TRANSACTION, e);

/** {@link noContextResult} for a scope: the source answered nothing, and no transaction was opened. */
export const noContextTransaction = (): QueryFailed => noContextResult(TRANSACTION);
