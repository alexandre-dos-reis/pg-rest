import type { DbSession } from "@tsql/adapters";
import {
  type SqlCall,
  type CoreConfig,
  type SqlEnv as CoreEnv,
  type SqlResult,
  type SqlPlan,
  type SqlQueryParams,
  type SqlRequestContext as RequestContext,
  assertRole,
  execute,
  identityOf,
  planRpc,
  planTable,
  shownBody,
  transactionSetup,
  useSchema,
} from "@tsql/core/core";
import { DbQueryError, EngineError } from "@tsql/core/errors";
import { type ErrorKind, describeErrorKind, describeFailure } from "./kinds";
import type { FieldRef } from "@tsql/core/parse/field";
import { parseField } from "@tsql/core/parse/field";
import {
  type Filter as ParsedFilter,
  type FilterNode,
  type Logic,
  type NodeParams,
  type Operator,
  type OrderTerm,
  type ParsedQuery,
  emptyParams,
  parseCount,
  parseOrderTerms,
  walkEmbeds,
} from "@tsql/core/parse/filter";
import { type SelectItem, parseSelect } from "@tsql/core/parse/select";
import { FTS_ORDER, IS_VALUES_ORDER, OPERATORS_ORDER, QUANTIFIABLE_ORDER } from "@tsql/core/parse/syntax";
import { getRelation } from "@tsql/core/schema";
import { literal, quoteIdent } from "@tsql/core/quote";
import { compileSet } from "@tsql/core/sql/expression";
import { ROOT_ALIAS } from "@tsql/core/constants";
import type { SqlOperation, SqlOutputFormat, SqlPreferences } from "@tsql/core/parse/sql-options";
import type { JsonObject } from "@tsql/core/sql/write";

/** What `preRequest` is told about the call it runs for. There is no request: no `Request`, no headers. */
export interface PreRequestInfo {
  readonly role: string;
  readonly claims: Readonly<Record<string, unknown>>;
  /** What the call does: to a table, or `rpc` for a function. */
  readonly operation: SqlOperation | "rpc";
  /** `/<table>` or `/rpc/<function>`: what the call stands for. */
  readonly path: string;
}

/** A SQL function (`"auth"."check"`) or a callback run in the call's transaction before its statement. */
export type PreRequest = string | ((session: DbSession, info: PreRequestInfo) => Promise<void>);

export interface QueryConfig extends CoreConfig {
  readonly preRequest?: PreRequest | undefined;
}

/** The engine's environment, with the settings `query()` reads on top. */
export interface Env extends CoreEnv {
  readonly config: QueryConfig;
}

/**
 * What a call adds to its transaction: `preRequest`, if there is one. There is no request, so none
 * of PostgREST's `request.*` settings are set.
 */
const callOf = (env: Env, ctx: RequestContext, operation: SqlOperation | "rpc", path: string): SqlCall => {
  const pre = env.config.preRequest;
  if (pre === undefined) return {};
  const { role, claims } = identityOf(env, ctx);
  return {
    before: async (session) => {
      if (typeof pre === "string") await session.query(`SELECT ${pre.split(".").map(quoteIdent).join(".")}()`);
      else await pre(session, { role, claims, operation, path });
    },
  };
};

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
 * The filter operators: the same type the parser works with, from the one list in `parse/syntax.ts`.
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
 * is stored as it is; an {@link Expression} or {@link DefaultValue} computes it in the
 * database. An object whose keys all start with `$` is an expression -- to store a `jsonb` value like
 * that, wrap it in `{ $val: … }`.
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
  /** The columns of the embedded resource, and its own embeds. Defaults to all of them. */
  readonly columns?: Select | undefined;
  /** Drop parent rows that have no match (`!inner`). */
  readonly inner?: boolean | undefined;
  /** Merge the embedded columns into the parent row (`...rel(*)`). */
  readonly spread?: boolean | undefined;
  /** Disambiguate the relationship: a foreign key name, or the table to join through. */
  readonly hint?: string | undefined;
  /** Rename the resource in the output (`client:clients(*)`). */
  readonly as?: string | undefined;
}

/**
 * What a write returns: the affected rows (`"representation"`, the default), nothing (`"minimal"`), or
 * the affected rows with only these columns and embeds -- the `RETURNING` of the statement.
 */
export type QueryReturning = "representation" | "minimal" | Select;

interface Common extends NodeFields {
  /** One of the exposed schemas. Defaults to the first one. */
  readonly schema?: string | undefined;
  /**
   * Return one object instead of an array. 0 or 2+ rows is a `not_single_row` error. An insert of a
   * single `rows` object does this on its own; `single: false` asks it for the array.
   */
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
  /** The columns to return, and the resources to embed. Defaults to all of them. */
  readonly columns?: Select | undefined;
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

/** Call a function, like `POST /rpc/name`. `columns`, `where` and `order` apply to its result. */
export interface RpcQuery extends Common {
  /** The function to call, like `POST /rpc/name`. */
  readonly name: string;
  readonly args?: Readonly<Record<string, unknown>> | undefined;
  readonly columns?: Select | undefined;
}

export type QueryInput = SelectQuery | InsertQuery | UpdateQuery | DeleteQuery | RpcQuery;

/** What `select` takes: a {@link SelectQuery} minus the `action`, which the method is. */
export type SelectInput = Omit<SelectQuery, "action">;
/** What `insert` takes: `rows` and the options of a plain insert (a conflict is `upsert`'s business). */
export type InsertInput = Omit<InsertQuery, "action" | "onConflict">;
/** What `upsert` takes: an insert that also names the columns a conflict is resolved on. */
export type UpsertInput = Omit<InsertQuery, "action">;
/** What `update` takes: `set`, and `where` for the rows to change. */
export type UpdateInput = Omit<UpdateQuery, "action">;
/** What `delete` takes: `where` for the rows to remove. */
export type DeleteInput = Omit<DeleteQuery, "action">;
/** What `rpc` takes: the function and its arguments. */
export type RpcInput = RpcQuery;

/**
 * What an operation answers with. `"result"` is the promise that never rejects (`data` or `error`);
 * `"ok"` is a query inside a transaction, which rejects on failure so that its result is the success.
 */
export type Settled<Mode extends "result" | "ok", T, C extends number | undefined> = Mode extends "ok"
  ? QueryOk<T, C>
  : QueryResult<T, C>;

/**
 * The six operations, one method each. `Ctx` is what follows the input: a context for an instance
 * or a `setContextQuery` object, nothing in a transaction, whose context was decided on entry.
 */
export interface Operations<Mode extends "result" | "ok", Ctx extends unknown[]> {
  /** Read rows from a table or view. */
  select<T = unknown, C extends number | undefined = number | undefined>(
    input: SelectInput,
    ...ctx: Ctx
  ): Promise<Settled<Mode, T, C>>;
  /** Insert one row or several. */
  insert<T = unknown, C extends number | undefined = number | undefined>(
    input: InsertInput,
    ...ctx: Ctx
  ): Promise<Settled<Mode, T, C>>;
  /** Insert, or update the row a conflict is found with (`onConflict`, the primary key by default). */
  upsert<T = unknown, C extends number | undefined = number | undefined>(
    input: UpsertInput,
    ...ctx: Ctx
  ): Promise<Settled<Mode, T, C>>;
  /** Change the rows `where` matches. */
  update<T = unknown, C extends number | undefined = number | undefined>(
    input: UpdateInput,
    ...ctx: Ctx
  ): Promise<Settled<Mode, T, C>>;
  /** Remove the rows `where` matches. */
  delete<T = unknown, C extends number | undefined = number | undefined>(
    input: DeleteInput,
    ...ctx: Ctx
  ): Promise<Settled<Mode, T, C>>;
  /** Call a function, like `POST /rpc/name`. */
  rpc<T = unknown, C extends number | undefined = number | undefined>(
    input: RpcInput,
    ...ctx: Ctx
  ): Promise<Settled<Mode, T, C>>;
}

/**
 * The six methods over one function that runs a {@link QueryInput}: each fixes the `action` the
 * method stands for and hands the rest on, so there is one way in to the engine.
 */
export const operationsOf = <X extends unknown[], R>(
  run: (input: QueryInput, ...rest: X) => R,
): Record<"select" | "insert" | "upsert" | "update" | "delete" | "rpc", (input: never, ...rest: X) => R> => ({
  select: (input, ...rest) => run({ ...(input as object), action: "select" } as QueryInput, ...rest),
  insert: (input, ...rest) => run({ ...(input as object), action: "insert" } as QueryInput, ...rest),
  upsert: (input, ...rest) => run({ ...(input as object), action: "upsert" } as QueryInput, ...rest),
  update: (input, ...rest) => run({ ...(input as object), action: "update" } as QueryInput, ...rest),
  delete: (input, ...rest) => run({ ...(input as object), action: "delete" } as QueryInput, ...rest),
  rpc: (input, ...rest) => run(input as QueryInput, ...rest),
});

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
  /** Always `null` here: `if (error)` is what separates the two halves. */
  readonly error: null;
}

/** The half a failed query answers with: no data, no count, and the error that explains it. */
export interface QueryFailed {
  readonly data: null;
  readonly count: undefined;
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
  if ("name" in input) return `rpc "${at}${input.name}"`;
  const target = "table" in input ? `"${at}${input.table}"` : "the database";
  return `${input.action ?? "select"} on ${target}`;
};

/**
 * The failure written out for a person: what was attempted, what the database or the parser said,
 * what to do about it, and the classification last -- so the first line alone is useful in a log
 * that cuts the rest off.
 */
const explain = (input: QueryInput, f: Fields, kind: ErrorKind): string =>
  [
    `${operationOf(input)} failed: ${f.message || describeErrorKind(kind)}`,
    f.details ? `  details: ${f.details}` : "",
    f.hint ? `  hint: ${f.hint}` : "",
    `  kind: ${kind} -- ${describeErrorKind(kind)}${f.sqlState ? ` (${f.sqlState})` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");

/** What a {@link QueryError} is made of, besides the input. */
interface Fields {
  readonly kind: ErrorKind;
  readonly message: string;
  readonly details?: string | null | undefined;
  readonly hint?: string | null | undefined;
  readonly sqlState?: string | undefined;
}

/** A query that failed, with what went wrong and the input that produced it. */
export class QueryError extends Error {
  /**
   * What went wrong, as one string out of a closed union: the thing to `switch` on. The exact
   * reason is in `message`, `details`, `hint` and, for a database error, `sqlState`.
   */
  readonly kind: ErrorKind;
  /** What the database or the parser said was wrong, when it said more than `message`. */
  readonly details: string | null;
  /** What to do about it, when the database or the parser knew. */
  readonly hint: string | null;
  /** The database's SQLSTATE (`23505`, `42501`...), for a failure that came from the database. */
  readonly sqlState: string | undefined;

  /**
   * The same failure written out for whoever reads the log: the call it came from, then what the
   * database or the parser said, then `details`, `hint` and the kind, each on its own line.
   *
   * `message` is left as the database or the parser said it -- one line, which is what a log
   * collector expects of an `Error.message`. This is the readable form, and it is opt-in.
   */
  readonly summary: string;

  constructor(
    readonly input: QueryInput,
    fields: Fields,
    options?: { readonly cause?: unknown },
  ) {
    super(fields.message);
    this.name = "QueryError";
    this.kind = fields.kind;
    this.details = fields.details ?? null;
    this.hint = fields.hint ?? null;
    this.sqlState = fields.sqlState;
    // a caller of query() holds the input too, which is what lets the explanation name the call
    this.summary = explain(input, fields, this.kind);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// input -> query parameters
// ---------------------------------------------------------------------------

const OPS: ReadonlySet<string> = new Set<FilterOp>(OPERATORS_ORDER);

/** Inside a list or a logic tree these read as something other than text, so such a string is quoted. */
const KEYWORDS: ReadonlySet<string> = new Set(["null", "true", "false", "unknown"]);

/** The query itself is wrong: `invalid_query`, however deep in the input it was found. */
export const bad = (message: string, hint?: string): EngineError =>
  new EngineError("invalid_input", message, null, hint ?? null);

/**
 * Render a value the way the query string carries it. A lone value is taken verbatim --
 * `name=eq.a,b` is the text `a,b` and `name=eq.null` is the text `null`, which is why
 * only a *delimited* context (a list or a logic tree, where `,` `)` and `.` separate)
 * needs quoting. `tests/compare` pins both.
 */
export const lit = (v: FilterValue | undefined, delimited: boolean): string => {
  if (v === undefined || v === null) return "null";
  // a composite value travels as JSON, which `valueSql` turns into a row of the column's type
  if (typeof v === "object") return lit(JSON.stringify(v), delimited);
  if (typeof v !== "string") return String(v);
  if (!delimited) return v;
  const quote = v === "" || KEYWORDS.has(v.toLowerCase()) || /[,()[\]{}".\\]/.test(v) || /^\s|\s$/.test(v);
  return quote ? `"${v.replace(/(["\\])/g, "\\$1")}"` : v;
};

/** Array values are a list for `in` and a PostgreSQL array literal for the containment operators. */
export const listOf = (op: FilterOp, values: ReadonlyArray<FilterValue>): string => {
  const items = values.map((v) => lit(v, true)).join(",");
  return op === "in" ? `(${items})` : `{${items}}`;
};

/** One condition on a column, once its modifiers are resolved: `[not.]op[(modifier)].value`. */
export interface Leaf {
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

export const toLeaves = (column: string, f: Filter): Leaf[] => {
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

/** The logic-tree keys, by the name the query string gives them. */
export const GROUPS: Readonly<Record<string, string>> = { $and: "and", $or: "or", $not: "not.and" };

export const isGroupKey = (key: string): boolean => key in GROUPS;

/** The members of a group: a list for `$and`/`$or`, one `Where` for `$not`. */
export const groupMembers = (key: string, value: unknown): ReadonlyArray<Where> => {
  if (key === "$not") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw bad("'$not' takes one group of conditions");
    return [value as Where];
  }
  if (!Array.isArray(value)) throw bad(`'${key}' takes a list of groups`);
  return value as ReadonlyArray<Where>;
};

/** A key that is neither a column nor a group. */
export const checkKey = (key: string): void => {
  if (isSpecKey(key) && !isGroupKey(key)) {
    throw bad(`Unknown key '${key}' in where`, "Only $and, $or and $not are reserved; a column is named without a $");
  }
};

export const isEmbed = (v: Select | Embed): v is Embed => !Array.isArray(v);

// ---------------------------------------------------------------------------
// input -> the engine's parsed form
// ---------------------------------------------------------------------------

// `@tsql/rest` hands the engine what it parsed from a query string. `query` has no string to parse: it
// builds the same `ParsedQuery` from its object, so none of PostgREST's grammar is in this package and
// the only text it reads is a column string (`"name->>first"`, `"total::text"`, `"count()"`).
// `tests/support/render.ts` renders an input the old way, as a query string, and
// `packages/query/tests/query-direct.test.ts` pins that the string, parsed by `@tsql/rest`, gives the same thing.

const QUANTIFIABLE_OPS: ReadonlySet<string> = new Set(QUANTIFIABLE_ORDER);
const IS_VALUES: ReadonlySet<string> = new Set(IS_VALUES_ORDER);
const CONFIG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One leaf as the parsed filter the engine plans. */
const filterOf = (field: FieldRef, leaf: Leaf): ParsedFilter => {
  // `col = NULL` is never true in SQL, so comparing with null is a NULL test
  if (leaf.value === null && (leaf.op === "eq" || leaf.op === "neq")) {
    return { kind: "filter", field, negate: leaf.not !== (leaf.op === "neq"), op: "is", value: "null" };
  }
  if (leaf.quantifier && leaf.config) {
    throw bad("A filter cannot have both a quantifier and a text-search configuration");
  }
  if (leaf.quantifier && !QUANTIFIABLE_OPS.has(leaf.op)) {
    throw bad(`'$${leaf.op}' cannot be wrapped in $${leaf.quantifier}`);
  }
  if (leaf.config && !(FTS_OPS.has(leaf.op) && CONFIG_NAME.test(leaf.config))) {
    throw bad(`'${leaf.config}' is not a text search configuration`);
  }
  let value: string | string[];
  if (Array.isArray(leaf.value)) {
    const items = leaf.value as ReadonlyArray<FilterValue>;
    value = leaf.op === "in" ? items.map((v) => lit(v, false)) : listOf(leaf.op, items);
  } else {
    if (leaf.op === "in") throw bad("'$in' takes a list", "Write { $in: [1, 2, 3] }");
    value = lit(leaf.value as FilterValue | undefined, false);
    if (leaf.op === "is") {
      value = value.toLowerCase();
      if (!IS_VALUES.has(value)) throw bad("'$is' takes null, not_null, true, false or unknown");
    }
  }
  return {
    kind: "filter",
    field,
    negate: leaf.not,
    op: leaf.op as Operator,
    ...(leaf.quantifier ? { quantifier: leaf.quantifier } : {}),
    ...(leaf.config ? { lang: leaf.config } : {}),
    value,
  };
};

/** The conditions on one column, as many as it has operators. */
const filtersOf = (column: string, f: Filter): ParsedFilter[] =>
  toLeaves(column, f).map((leaf) => filterOf(parseField(column), leaf));

/** `$and`, `$or` or `$not` as a logic node: a `$not` group is the AND of its conditions, inverted. */
const groupOf = (key: string, value: unknown): Logic => {
  const members = groupMembers(key, value);
  if (key === "$not") {
    const children = conditionsOf(members[0]!);
    if (children.length === 0) throw bad("A $not group cannot be empty");
    return { kind: "logic", op: "and", negate: true, children };
  }
  if (members.length === 0) throw bad(`'${key}' needs at least one group`);
  return { kind: "logic", op: key === "$and" ? "and" : "or", negate: false, children: members.map(memberOf) };
};

/** One member of an `$and`/`$or` list: several conditions in the same object are ANDed. */
const memberOf = (w: Where): FilterNode => {
  const parts = conditionsOf(w);
  if (parts.length === 0) throw bad("An $and/$or group cannot be empty");
  return parts.length === 1 ? parts[0]! : { kind: "logic", op: "and", negate: false, children: parts };
};

/** Every condition of a `Where` inside a group, where a key is a column and never a path to an embed. */
const conditionsOf = (w: Where): FilterNode[] =>
  Object.entries(w).flatMap(([key, value]): FilterNode[] => {
    if (value === undefined) return [];
    checkKey(key);
    return isGroupKey(key) ? [groupOf(key, value)] : filtersOf(key, value as Filter);
  });

const orderOf = (o: Order): OrderTerm[] => {
  if (typeof o === "string") return parseOrderTerms(o);
  // `nulls` ends up in the statement as a keyword: the type says "first" | "last", but a value that
  // came from JSON is not checked by the type
  if (o.nulls !== undefined && o.nulls !== "first" && o.nulls !== "last") {
    throw bad(`Invalid nulls placement ${JSON.stringify(o.nulls)}`, 'Use "first" or "last".');
  }
  return [{ field: parseField(o.column), dir: o.desc ? "desc" : "asc", ...(o.nulls ? { nulls: o.nulls } : {}) }];
};

/** What is known while a query is built: the embeds the select names, and the nodes that got something. */
interface Built {
  readonly known: Map<string, string>;
  readonly nodes: Map<string, NodeParams>;
  readonly root: NodeParams;
}

/** The parameters of the node at `path`: the root, or an embed the select names. */
const nodeAt = (built: Built, path: ReadonlyArray<string>): NodeParams => {
  if (path.length === 0) return built.root;
  const joined = path.join(".");
  const canonical = built.known.get(joined);
  if (!canonical) {
    throw new EngineError(
      "not_embedded",
      `'${joined}' is not an embedded resource in this request`,
      null,
      `Verify that '${joined}' is included in the 'select' query parameter.`,
    );
  }
  let node = built.nodes.get(canonical);
  if (!node) built.nodes.set(canonical, (node = emptyParams()));
  return node;
};

/** `where`, `order`, `limit` and `offset` of one node, which sits at `path` in the select. */
const addNode = (built: Built, node: NodeFields, path: ReadonlyArray<string>): void => {
  for (const [key, value] of Object.entries(node.where ?? {})) {
    if (value === undefined) continue;
    checkKey(key);
    if (isGroupKey(key)) {
      nodeAt(built, path).filters.push(groupOf(key, value));
      continue;
    }
    // a dotted key filters an embedded resource, and keeps its own path
    const parts = [...path, ...key.split(".")];
    const column = parts.pop()!;
    const parent = nodeAt(built, parts);
    const isEmbedItself = built.known.has([...parts, column].join("."));
    for (const leaf of toLeaves(key, value as Filter)) {
      const f = filterOf(parseField(column), leaf);
      if (!isEmbedItself) {
        parent.filters.push(f);
      } else if (f.op === "is" && f.value === "null") {
        // `{ clients: null }`: the parent rows that have no such embedded row
        parent.presence.push({
          embed: built.known
            .get([...parts, column].join("."))!
            .split(".")
            .pop()!,
          present: f.negate,
        });
      } else {
        throw new EngineError(
          "invalid_embed_filter",
          "Embedded resource filter only accepts is.null or not.is.null",
          null,
          null,
        );
      }
    }
  }
  const terms = (node.order ?? []).flatMap(orderOf);
  if (terms.length) nodeAt(built, path).order.push(...terms);
  // a count that is not an integer is ignored, the way a `limit=1.5` is
  if (node.limit !== undefined) {
    const n = parseCount("limit", String(node.limit));
    if (n !== undefined) nodeAt(built, path).limit = n;
  }
  if (node.offset !== undefined) {
    const n = parseCount("offset", String(node.offset));
    if (n !== undefined) nodeAt(built, path).offset = n;
  }
};

/** The select items, and the embeds among them with the path each sits at: they carry their own filters. */
const selectOf = (
  items: Select,
  path: ReadonlyArray<string>,
  embeds: Array<{ readonly node: Embed; readonly path: ReadonlyArray<string> }>,
): SelectItem[] => {
  const out: SelectItem[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      out.push(...parseSelect(item));
      continue;
    }
    for (const [relation, spec] of Object.entries(item)) {
      const embed: Embed = isEmbed(spec) ? spec : { columns: spec };
      if (embed.spread && embed.as) throw bad(`'${relation}' is spread, so it cannot be renamed`);
      const here = [...path, embed.as ?? relation];
      embeds.push({ node: embed, path: here });
      out.push({
        kind: "embed",
        target: relation,
        ...(embed.as ? { alias: embed.as } : {}),
        ...(embed.hint ? { hint: embed.hint } : {}),
        join: embed.inner ? "inner" : "left",
        spread: Boolean(embed.spread),
        items: selectOf(embed.columns ?? ["*"], here, embeds),
      });
    }
  }
  return out;
};

/**
 * The columns a call asks for: `columns` on a read or a function call, and on a write the list
 * `returning` may be. (An insert's own `columns` is something else: the columns it inserts.)
 */
const columnsOf = (input: QueryInput): Select | undefined => {
  if (isRpc(input)) return input.columns;
  if (input.action === undefined || input.action === "select") return (input as SelectQuery).columns;
  const asked = (input as InsertQuery | UpdateQuery | DeleteQuery).returning;
  return asked === undefined || typeof asked === "string" ? undefined : asked;
};

/**
 * The names a query carries are identifiers: they are quoted later, but a value that is not a string
 * must not be turned into one by `String()` (an object with its own `toString`).
 */
const assertNames = (input: QueryInput): void => {
  // a typed API does not cut a value where the database would: a NUL byte is refused
  try {
    if (JSON.stringify(input).includes("\\u0000")) throw bad("A NUL byte cannot be part of a query");
  } catch (e) {
    if (e instanceof EngineError) throw e;
  }
  for (const [what, v] of [
    ["table", (input as SelectQuery).table],
    ["name", (input as RpcQuery).name],
    ["schema", input.schema],
  ] as const) {
    if (v !== undefined && typeof v !== "string") throw bad(`"${what}" must be a string`);
  }
};

/** `input` as the engine's parsed form: what a query string with the same meaning parses to. */
export const toParsed = (input: QueryInput): ParsedQuery => {
  assertNames(input);
  const embeds: Array<{ readonly node: Embed; readonly path: ReadonlyArray<string> }> = [];
  const listed = columnsOf(input);
  const select: SelectItem[] = listed?.length ? selectOf(listed, [], embeds) : [{ kind: "star" }];
  const known = new Map<string, string>();
  walkEmbeds(select, [], known);
  const built: Built = { known, nodes: new Map(), root: emptyParams() };
  addNode(built, input, []);
  for (const { node, path } of embeds) addNode(built, node, path);
  const insert = "action" in input && (input.action === "insert" || input.action === "upsert");
  const names = (list: ReadonlyArray<string> | undefined) =>
    insert && list?.length ? list.filter(Boolean) : undefined;
  const onConflict = names((input as InsertQuery).onConflict);
  const columns = names((input as InsertQuery).columns);
  return {
    select,
    root: built.root,
    embeds: built.nodes,
    ...(onConflict?.length ? { onConflict: [...onConflict] } : {}),
    ...(columns?.length ? { columns: [...columns] } : {}),
  };
};

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

const isRpc = (input: QueryInput): input is RpcQuery => "name" in input;

const tableOperationOf = (input: QueryInput): SqlOperation => {
  switch (isRpc(input) ? "select" : (input.action ?? "select")) {
    case "select":
      return "read";
    case "insert":
    case "upsert":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
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
  return tableOperationOf(input) !== "read" && !isRpc(input);
};

/**
 * Unlike HTTP, a write defaults to returning its rows: a function that gives nothing back
 * is of little use in a program. `returning: "minimal"` gives nothing back, and a list of columns
 * gives back the rows with only those.
 */
const returningOf = (input: QueryInput): "representation" | "minimal" | undefined => {
  if (!writes(input)) return undefined;
  const asked = (input as InsertQuery | UpdateQuery | DeleteQuery).returning;
  return typeof asked === "string" ? asked : "representation";
};

/**
 * Whether the answer is one object rather than a list. `single` says so outright; an insert of one
 * object says so by itself -- `rows` is the only write input that states its own cardinality, an
 * object being exactly one row by construction. `single: false` asks for the list back.
 */
const singleOf = (input: QueryInput): boolean => {
  if (input.single !== undefined) return input.single;
  if (isRpc(input) || !("action" in input)) return false;
  if (input.action !== "insert" && input.action !== "upsert") return false;
  return !Array.isArray((input as InsertQuery).rows);
};

const preferencesOf = (input: QueryInput): SqlPreferences => ({
  ...(returningOf(input) ? { return: returningOf(input) } : {}),
  ...(input.count ? { count: input.count } : {}),
  ...("action" in input && input.action === "upsert" ? { resolution: "merge-duplicates" as const } : {}),
  ...("action" in input && input.action === "insert" && (input as InsertQuery).missing
    ? { missing: (input as InsertQuery).missing }
    : {}),
  ...(input.maxAffected !== undefined ? { handling: "strict" as const, maxAffected: input.maxAffected } : {}),
  ...(input.timezone ? { timezone: input.timezone } : {}),
});

const run = async (env: Env, given: QueryInput | Prepared, ctx: RequestContext): Promise<Omit<QueryOk, "error">> => {
  if (isPrepared(given)) return runPrepared(env, given, ctx);
  const input = given;
  assertNames(input);
  assertRole(env, ctx);
  if (isRpc(input) && "table" in input) {
    throw bad("A query names either a table or an rpc, not both");
  }
  const schema = useSchema(env, input.schema);
  const operation = tableOperationOf(input);
  const prefer = preferencesOf(input);
  const format: SqlOutputFormat = singleOf(input)
    ? { kind: "object", stripNulls: Boolean(input.stripNulls) }
    : { kind: "json", stripNulls: Boolean(input.stripNulls) };
  const parsed = toParsed(input);
  let qp: SqlQueryParams = { params: [], bare: new Set<string>(), parse: () => parsed, bind: true };
  let body = bodyOf(input);
  if (!isRpc(input) && "action" in input && input.action === "update") {
    // the expressions of `set` are compiled here, the plain values stay the JSON body
    const set = compileSet(input.set, getRelation(env.cache, schema, input.table), ROOT_ALIAS);
    body = { kind: "json", value: set.plain };
    qp = { ...qp, setClauses: set.clauses };
  }

  const plan: SqlPlan = isRpc(input)
    ? planRpc(env, true, schema, input.name, qp, prefer, format, undefined, body)
    : planTable(env, operation, schema, input.table, qp, prefer, format, undefined, body);

  const path = isRpc(input) ? `/rpc/${input.name}` : `/${input.table}`;
  const outcome = await execute(
    env,
    ctx,
    callOf(env, ctx, isRpc(input) ? "rpc" : operation, path),
    schema,
    prefer,
    format,
    plan,
  );
  return answerOf(plan, outcome);
};

const answerOf = (plan: SqlPlan, result: SqlResult): Omit<QueryOk, "error"> => {
  const text = shownBody(plan, result.body);
  return { data: text === "" ? null : (JSON.parse(text) as unknown), count: result.total };
};

/**
 * Run a query described by an object, in-process. Nothing here is HTTP: no request, no URL, no status.
 *
 * **This never rejects.** Every failure, including one the library did not foresee, comes back as
 * the `error` of the result, so a caller that checks it needs no `try`/`catch` at all.
 */
export const runQuery = async (
  env: Env,
  input: QueryInput | Prepared,
  ctx: RequestContext = {},
): Promise<QueryResult> => {
  try {
    return { ...(await run(env, input, ctx)), error: null };
  } catch (e) {
    return failureOf(env, ctx, inputOf(input), e);
  }
};

// ---------------------------------------------------------------------------
// prepared queries
// ---------------------------------------------------------------------------

/** What a prepared query takes: values, by name. */
export type PreparedArgs = { readonly [name: string]: Scalar };

const PREPARED = Symbol("tsql.prepared");

/**
 * One call of a prepared query, as `prepare()` returns it: hand it to `query`, `tx.query` or a
 * `setContextQuery` function, wherever a query object goes. `T` and `C` are what `data` and
 * `count` will be.
 */
export interface Prepared<T = unknown, C extends number | undefined = number | undefined> {
  /** Not for reading: this only carries `T` and `C` to the result type. */
  readonly __result?: { readonly data: T; readonly count: C };
  readonly [PREPARED]: PreparedPlan;
  readonly args: PreparedArgs;
}

interface Template {
  readonly parts: ReadonlyArray<string>;
  /** `parts[i + 1]` follows the value of argument `slots[i]`. */
  readonly slots: ReadonlyArray<number>;
}

interface PreparedPlan {
  readonly names: ReadonlyArray<string>;
  readonly build: (args: PreparedArgs) => QueryInput;
  readonly plan: SqlPlan;
  /** The statement; text with a literal for an argument only where a value could not be bound (a json column). */
  readonly statement: Template;
  readonly planned: Template | undefined;
  /** The parameters: `args[i]` is the argument a parameter is made of, or `undefined` when it is fixed. */
  readonly params: ReadonlyArray<number | undefined>;
  readonly operation: SqlOperation;
  readonly schema: string;
  readonly prefer: SqlPreferences;
  readonly format: SqlOutputFormat;
  readonly path: string;
}

const isPrepared = (x: unknown): x is Prepared => typeof x === "object" && x !== null && PREPARED in x;

/** The query object a call stands for, for a failure to name. */
const inputOf = (x: QueryInput | Prepared): QueryInput => {
  if (!isPrepared(x)) return x;
  try {
    return x[PREPARED].build(x.args);
  } catch {
    return { table: x[PREPARED].path.slice(1) };
  }
};

/**
 * Cut `sql` at the literals that stand for arguments. A literal is `'<marker>'`, and nothing else
 * may hold the marker: an argument used as a column, an operator or a number would be baked into the
 * SQL and not follow the value.
 */
const templateOf = (sql: string, marker: string, names: ReadonlyArray<string>): Template => {
  const parts: string[] = [];
  const slots: number[] = [];
  let from = 0;
  for (const m of sql.matchAll(new RegExp(`'${marker}x(\\d+)x'`, "g"))) {
    parts.push(sql.slice(from, m.index));
    slots.push(Number(m[1]));
    from = m.index + m[0].length;
  }
  parts.push(sql.slice(from));
  const stray = parts.find((p) => p.includes(marker));
  if (stray !== undefined) {
    throw new TypeError(
      "prepare: an argument is used somewhere other than a value to compare with (a column, an operator, a limit...); only filter values can change between calls",
    );
  }
  void names;
  return { parts, slots };
};

const fill = (t: Template, literals: ReadonlyArray<string>): string => {
  let out = t.parts[0]!;
  for (let i = 0; i < t.slots.length; i++) out += literals[t.slots[i]!]! + t.parts[i + 1]!;
  return out;
};

/**
 * A value whose SQL is the same text in any position it can take: the literal of its string form.
 * `null` is a different comparison (`IS NULL`), a `*` is a wildcard for `like`, and a value that
 * opens a `{` may be a composite: those change the SQL itself, so they take the long way.
 */
const isPlain = (v: unknown): v is string | number | boolean => {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "boolean") return true;
  return typeof v === "string" && !v.includes("*") && !v.trimStart().startsWith("{");
};

/**
 * Plan a query once and answer a function that fills in its values. `build` is called here with a
 * stand-in for each argument it reads, and the SQL that comes out is cut at those stand-ins, so a
 * call is string concatenation and the statement goes to the driver: no parsing, no planning.
 *
 * The consequence is that the *shape* of the query must not depend on the arguments: `build` may
 * use them as filter values and nothing else. A call whose values would change the SQL itself
 * (`null`, a `*` wildcard, a composite) is not an error: it builds the query object and runs it
 * the ordinary way.
 */
export const prepareQuery = <A extends PreparedArgs>(env: Env, build: (args: A) => QueryInput) => {
  const marker = `tsql${Math.random()
    .toString(36)
    .slice(2, 10)
    .replace(/[^a-z0-9]/g, "z")}`;
  const names: string[] = [];
  const stand = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (typeof key !== "string") return undefined;
        let i = names.indexOf(key);
        if (i < 0) i = names.push(key) - 1;
        return `${marker}x${i}x`;
      },
    },
  ) as A;

  const input = build(stand);
  if (isRpc(input) || ("action" in input && input.action !== undefined && input.action !== "select")) {
    throw new TypeError("prepare: only a select on a table can be prepared");
  }
  const schema = useSchema(env, input.schema);
  const prefer = preferencesOf(input);
  const format: SqlOutputFormat = input.single
    ? { kind: "object", stripNulls: Boolean(input.stripNulls) }
    : { kind: "json", stripNulls: Boolean(input.stripNulls) };
  const parsed = toParsed(input);
  const qp: SqlQueryParams = { params: [], bare: new Set<string>(), parse: () => parsed, bind: true };
  const plan = planTable(env, "read", schema, input.table, qp, prefer, format, undefined, undefined);

  const statement = templateOf(plan.statement, marker, names);
  const planned = plan.planned === undefined ? undefined : templateOf(plan.planned, marker, names);
  // a bound value is a parameter that is the stand-in itself; a stand-in inside a longer parameter
  // (a containment array) would need the quoting of its value, which only the ordinary route does
  const whole = new RegExp(`^${marker}x(\\d+)x$`);
  const params = plan.params.map((p) => {
    const m = whole.exec(p);
    if (m) return Number(m[1]);
    if (p.includes(marker)) {
      throw new TypeError(
        "prepare: an argument is used inside a list or an array literal (`$cs`, `$cd`, `$ov`...); use it as a whole value",
      );
    }
    return undefined;
  });
  const used = new Set([...statement.slots, ...(planned?.slots ?? []), ...params.filter((i) => i !== undefined)]);
  const unused = names.filter((_n, i) => !used.has(i));
  if (unused.length) {
    throw new TypeError(`prepare: ${unused.map((n) => `'${n}'`).join(", ")} never ends up as a value in the SQL`);
  }

  const compiled: PreparedPlan = {
    names,
    build: build as (args: PreparedArgs) => QueryInput,
    plan,
    statement,
    planned,
    params,
    operation: "read",
    schema,
    prefer,
    format,
    path: `/${input.table}`,
  };
  return (args: A): Prepared => ({ [PREPARED]: compiled, args });
};

const runPrepared = async (env: Env, call: Prepared, ctx: RequestContext): Promise<Omit<QueryOk, "error">> => {
  const c = call[PREPARED];
  const values = c.names.map((n) => call.args[n]);
  // a value that changes the SQL itself: build the object and run it like any other
  if (!values.every(isPlain)) return run(env, c.build(call.args), ctx);
  assertRole(env, ctx);
  const texts = values.map(String);
  // the statement is the same text for every call, except where a value could only be a literal
  const literals = c.statement.slots.length || c.planned?.slots.length ? texts.map((t) => literal(t)) : [];
  const plan: SqlPlan = {
    ...c.plan,
    statement: c.statement.slots.length ? fill(c.statement, literals) : c.plan.statement,
    planned: c.planned && (c.planned.slots.length ? fill(c.planned, literals) : c.plan.planned),
    params: c.params.map((slot, i) => (slot === undefined ? c.plan.params[i]! : texts[slot]!)),
  };
  const outcome = await execute(env, ctx, callOf(env, ctx, c.operation, c.path), c.schema, c.prefer, c.format, plan);
  return answerOf(plan, outcome);
};

/**
 * Map anything thrown into the failed half of a result, the way `query()` does: a `QueryError`
 * keeps the input it already names, and anything the engine or the parser raised becomes a kind.
 * What nobody foresaw is `internal`, with the original under `cause`.
 */
const failureOf = (env: Env, ctx: RequestContext, input: QueryInput, e: unknown): QueryFailed => {
  if (e instanceof QueryError) return toFailedResult(e.input, e);
  const f = describeFailure(e, ctx.role ?? env.config.anonymousRole, env.config.anonymousRole);
  // An unexpected error keeps its stack under `cause`: the message alone would not say where it came from.
  return toFailedResult(input, new QueryError(input, f, f.unexpected ? { cause: e } : undefined));
};

/**
 * Turn anything at all into the failed half of a {@link QueryResult}. `runQuery` maps what it can;
 * whatever it could not still arrives, as an `internal` error with the original under `cause`.
 * Nothing is logged and nothing is dropped: `error` is the only channel, so the caller decides what
 * to do with it.
 */
export const toFailedResult = (given: QueryInput | Prepared, e: unknown): QueryFailed => {
  const input = inputOf(given);
  const error =
    e instanceof QueryError ? e : new QueryError(input, { kind: "internal", message: "Internal error" }, { cause: e });
  return { data: null, count: undefined, error };
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
 * It carries the six operations and `transaction`: a scope is the other place application code runs a
 * query, and it reads the same source -- once, on entry, because the transaction has one
 * `set_config`.
 */
export interface ContextQuery extends Operations<"result", [ctx?: RequestContext]> {
  /** Run a call of a prepared query, with this context. */
  run<T, C extends number | undefined>(call: Prepared<T, C>, ctx?: RequestContext): Promise<QueryResult<T, C>>;
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
export const noContextResult = (given: QueryInput | Prepared): QueryFailed =>
  toFailedResult(
    given,
    new QueryError(inputOf(given), {
      kind: "no_context",
      message: "No request context",
      details: "The context source of setContextQuery() returned nothing",
      hint: "Run the query inside the scope that provides it, or pass a context as the second argument",
    }),
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
 * One transaction, several queries. Its operations are the instance's minus the context: the role and the
 * claims were set with `set_config(..., true)` once at the head of the transaction, and re-issuing
 * them halfway through would change the role for every statement that follows instead of scoping
 * anything -- so a context here is a type error rather than an argument quietly ignored.
 *
 * What differs from the instance is the failure, and for one reason -- a query that failed is a
 * transaction that will not commit, so there is nothing for the rest of the callback to do with it.
 * An operation **rejects** instead of answering an `error`, which is what makes the result the
 * success: `data` is not null, `count` is the number the query asked for, and nothing has to be
 * narrowed. `transaction()` catches it, rolls the transaction back and hands it to you as its own
 * `error`, so the promise that does not reject is still there -- it is the scope's now.
 *
 * ```ts ignore
 * const { data, count } = await tx.select({ table: "todos", columns: ["id"], count: "exact" });
 * ```
 *
 * To *look* at a failure rather than leave on it, use {@link Transaction.transaction}: a savepoint
 * is the only place a transaction can carry on after one.
 */
export interface Transaction extends Operations<"ok", []> {
  /** Run a call of a prepared query in this transaction. Like the operations, it rejects on failure. */
  run<T, C extends number | undefined>(call: Prepared<T, C>): Promise<QueryOk<T, C>>;
  /**
   * A nested scope, on a `SAVEPOINT`: it rolls back on its own when it fails, leaving the
   * transaction around it usable. That is how one query is allowed to fail inside a scope -- and
   * unlike an operation, this answers a {@link QueryResult} rather than rejecting, because here the
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

const scopeError = (message: string, details: string | null, hint: string | null): QueryError =>
  new QueryError(TRANSACTION, { kind: "rolled_back", message, details, hint });

const scopeFailure = (message: string, details: string | null, hint: string | null): QueryFailed =>
  toFailedResult(TRANSACTION, scopeError(message, details, hint));

/** The first failure in a scope: it cannot commit any more, and says so rather than answering `25P02`. */
interface ScopeState {
  failed?: QueryError | undefined;
}

/** What a scope's callback left behind: a value to commit on, or the failure to roll back for. */
type Outcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly failed: QueryFailed };

const okResult = <A>(value: A): QueryResult<A, undefined> => ({
  data: value,
  count: undefined,
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
      "Transaction already failed",
      `An earlier query in this transaction failed (${state.failed!.sqlState ?? state.failed!.kind}), so it will roll back`,
      "Wrap the queries allowed to fail in tx.transaction(), which runs them in a savepoint of their own",
    );

  const exec = async <T = unknown, C extends number | undefined = number | undefined>(
    input: QueryInput | Prepared<T, C>,
  ): Promise<QueryOk<T, C>> => {
    if (state.failed) throw refused();
    const result = (await runQuery(env, input, ctx)) as QueryResult<T, C>;
    // A failure the library raised to undo its own write (`not_single_row`, `too_many_affected`) did not abort
    // anything by itself, so the scope records it before leaving: `error` must not come back
    // from a transaction that kept the row, whatever the callback does next.
    if (result.error) {
      state.failed = result.error;
      throw result.error;
    }
    return result;
  };

  const tx: Transaction = {
    ...(operationsOf((input: QueryInput) => exec(input)) as unknown as Operations<"ok", []>),
    run: exec,

    transaction: async <B>(nested: (tx: Transaction) => Promise<B>): Promise<QueryResult<B, undefined>> => {
      if (state.failed) return toFailedResult(TRANSACTION, refused()) as QueryResult<B, undefined>;
      const name = `tsql_sp_${++names.n}`;
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
        failed: scopeFailure("Transaction rolled back", "rollback() was called in the scope", null),
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
        if (e.failed.error.sqlState !== undefined && again(e.failed.error.sqlState)) {
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
