import { EngineError } from "../errors";
import { literal, quoteIdent, safeType } from "../quote";
import type { Relation } from "../schema";

/**
 * The expressions of an `UPDATE … SET`: PostgreSQL's `column = { expression | DEFAULT }`, written as
 * objects whose keys start with `$`. (`(a, b) = ROW(…)` is `a = …, b = …`; there is no multi-column
 * form.)
 *
 * Nothing here is raw SQL. Every node is one of a fixed set of operators; a column is checked
 * against the relation, a type goes through `safeType`, and a value is an escaped literal. The
 * output is only meant for `query()`: HTTP carries a PATCH body, which stays PostgREST's own.
 */

const bad = (message: string, hint?: string): EngineError =>
  new EngineError("invalid_input", message, null, hint ?? null);

interface Scope {
  readonly rel: Relation;
  readonly alias: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** An object whose keys all start with `$` is an expression; any other object is a plain value. */
export const isExpression = (v: unknown): v is Record<string, unknown> => {
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
};

// ---------------------------------------------------------------------------
// operators
// ---------------------------------------------------------------------------

/** n-ary, left to right: `{ $add: [a, b, c] }` is `(a + b + c)`. */
const NARY: Readonly<Record<string, string>> = {
  $add: "+",
  $sub: "-",
  $mul: "*",
  $div: "/",
  $mod: "%",
  $pow: "^",
  $concat: "||",
  $and: "AND",
  $or: "OR",
};

/** Exactly two operands. */
const BINARY: Readonly<Record<string, string>> = {
  $eq: "=",
  $neq: "<>",
  $gt: ">",
  $gte: ">=",
  $lt: "<",
  $lte: "<=",
  $cs: "@>",
  $cd: "<@",
  $ov: "&&",
};

const UNARY: Readonly<Record<string, string>> = { $not: "NOT", $neg: "-" };

/** Functions of a list of operands, of any length. */
const FUNCTIONS: Readonly<Record<string, string>> = { $coalesce: "COALESCE", $greatest: "GREATEST", $least: "LEAST" };

/** Functions of one operand: `{ $lower: { $col: "name" } }`. */
const UNARY_FUNCTIONS: Readonly<Record<string, string>> = {
  $lower: "LOWER",
  $upper: "UPPER",
  $trim: "BTRIM",
  $length: "LENGTH",
  $abs: "ABS",
};

/** Functions of exactly two operands: `{ $arrayAppend: [{ $col: "tags" }, "vip"] }`. */
const BINARY_FUNCTIONS: Readonly<Record<string, string>> = {
  $arrayAppend: "ARRAY_APPEND",
  $arrayRemove: "ARRAY_REMOVE",
};

/** Every function the expressions know, and nothing else: a name is never taken from the input. */
const OTHER_KEYS = ["$now", "$round"] as const;

/** Every key an expression may carry, for the error that lists them. */
export const EXPRESSION_KEYS: ReadonlyArray<string> = [
  "$col",
  "$val",
  "$default",
  "$cast",
  ...Object.keys(NARY),
  ...Object.keys(BINARY),
  ...Object.keys(UNARY),
  ...Object.keys(FUNCTIONS),
  ...Object.keys(UNARY_FUNCTIONS),
  ...Object.keys(BINARY_FUNCTIONS),
  ...OTHER_KEYS,
];

// ---------------------------------------------------------------------------
// literals
// ---------------------------------------------------------------------------

/** One element of a PostgreSQL array literal (`{"a","b"}`). */
const arrayElement = (v: unknown): string => {
  if (v === null) return "NULL";
  if (Array.isArray(v)) return `{${v.map(arrayElement).join(",")}}`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return `"${text.replace(/(["\\])/g, "\\$1")}"`;
};

/**
 * A value as an SQL literal. A number, boolean or null has a type of its own; a string, an array
 * or an object is a literal of unknown type, so that the column or operator beside it decides
 * (`meta || '{"a":1}'` is a `jsonb` merge, `tags || 'x'` appends to a `text[]`).
 */
const valueSql = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw bad("A number in an expression must be finite");
    return String(v);
  }
  if (typeof v === "string") return literal(v);
  if (Array.isArray(v)) return literal(arrayElement(v));
  return literal(JSON.stringify(v));
};

const columnOf = (rel: Relation, name: unknown): string => {
  if (typeof name !== "string" || !rel.columns.some((c) => c.name === name)) {
    throw new EngineError(
      "unknown_column",
      `Could not find the '${String(name)}' column of '${rel.name}' in the schema cache`,
      null,
      null,
    );
  }
  return name;
};

// ---------------------------------------------------------------------------
// compiler
// ---------------------------------------------------------------------------

const list = (node: unknown, key: string): unknown[] => {
  if (!Array.isArray(node) || node.length < 1) throw bad(`'${key}' takes a list of operands`);
  return node;
};

/** An expression as SQL. `DEFAULT` is not one: it is only valid as a whole assignment. */
export const compileExpression = (node: unknown, scope: Scope): string => {
  if (!isObject(node) && !Array.isArray(node)) return valueSql(node);
  if (Array.isArray(node)) {
    throw bad("An array is not an expression", "Write { $val: [...] } for an array value");
  }
  const keys = Object.keys(node);
  if (keys.length !== 1 || !keys[0]!.startsWith("$")) {
    throw bad(
      `An expression is an object with exactly one operator, found: ${keys.join(", ") || "{}"}`,
      "Write { $val: … } for a JSON value",
    );
  }
  const key = keys[0]!;
  const arg = node[key];
  const expr = (n: unknown) => compileExpression(n, scope);

  if (key === "$val") return valueSql(arg);
  if (key === "$col") return `${quoteIdent(scope.alias)}.${quoteIdent(columnOf(scope.rel, arg))}`;
  if (key === "$default") throw bad("'$default' can only be a whole assignment, not part of an expression");
  if (key === "$cast") {
    if (!Array.isArray(arg) || arg.length !== 2 || typeof arg[1] !== "string") {
      throw bad("'$cast' takes [expression, type]");
    }
    return `(${expr(arg[0])})::${safeType(arg[1])}`;
  }
  if (key in NARY) {
    const operands = list(arg, key);
    if (operands.length < 2) throw bad(`'${key}' takes at least two operands`);
    return `(${operands.map(expr).join(` ${NARY[key]} `)})`;
  }
  if (key in BINARY) {
    const operands = list(arg, key);
    if (operands.length !== 2) throw bad(`'${key}' takes exactly two operands`);
    return `(${expr(operands[0])} ${BINARY[key]} ${expr(operands[1])})`;
  }
  if (key in UNARY) return `(${UNARY[key]} ${expr(arg)})`;
  if (key in FUNCTIONS) return `${FUNCTIONS[key]}(${list(arg, key).map(expr).join(", ")})`;
  if (key in UNARY_FUNCTIONS) return `${UNARY_FUNCTIONS[key]}(${expr(arg)})`;
  if (key in BINARY_FUNCTIONS) {
    const operands = list(arg, key);
    if (operands.length !== 2) throw bad(`'${key}' takes exactly two operands`);
    return `${BINARY_FUNCTIONS[key]}(${expr(operands[0])}, ${expr(operands[1])})`;
  }
  if (key === "$now") {
    if (arg !== true) throw bad("Write { $now: true } for now()");
    return "now()";
  }
  if (key === "$round") {
    const operands = list(arg, key);
    if (operands.length > 2) throw bad("'$round' takes [expression] or [expression, digits]");
    return `ROUND(${operands.map(expr).join(", ")})`;
  }
  throw bad(`Unknown operator '${key}' in an expression`, `The operators are: ${EXPRESSION_KEYS.join(", ")}`);
};

// ---------------------------------------------------------------------------
// SET
// ---------------------------------------------------------------------------

/** The right-hand side of `column = …`: an expression, or `DEFAULT`. */
const assigned = (node: unknown, scope: Scope): string => {
  if (isObject(node) && Object.keys(node).length === 1 && "$default" in node) {
    if (node["$default"] !== true) throw bad("Write { $default: true } for DEFAULT");
    return "DEFAULT";
  }
  return compileExpression(node, scope);
};

export interface CompiledSet {
  /** The plain values: PostgREST's own PATCH body, untouched. */
  readonly plain: Record<string, unknown>;
  /** The `col = expr` clauses, as SQL. */
  readonly clauses: string[];
}

/**
 * Split a `set` into what PostgREST already means (plain values, which keep going through
 * `json_populate_record`) and the extension (expressions and `DEFAULT`).
 */
export const compileSet = (set: Record<string, unknown>, rel: Relation, alias: string): CompiledSet => {
  const scope: Scope = { rel, alias };
  const plain: Record<string, unknown> = {};
  const clauses: string[] = [];
  for (const [key, value] of Object.entries(set)) {
    if (key.startsWith("$")) {
      throw bad(`Unknown key '${key}' in set`, "The keys of set are the columns of the table");
    } else if (isExpression(value)) {
      columnOf(rel, key);
      clauses.push(`${quoteIdent(key)} = ${assigned(value, scope)}`);
    } else {
      plain[key] = value;
    }
  }
  return { plain, clauses };
};
