import { EngineError } from "../errors";
import type { FieldRef } from "../parse/field";
import type { Filter, FilterNode, Operator, OrderTerm } from "../parse/filter";
import { literal, quoteIdent, quoteQualified } from "../quote";
import type { Relation } from "../schema";
import type { Values } from "./values";

const declaredType = (rel: Relation | undefined, name: string): string | undefined =>
  rel?.columns.find((c) => c.name === name)?.type.trim();

/**
 * Whether an arrow path has to go through `to_jsonb()`. Only `json` and `jsonb` take `->` directly;
 * everything else -- a composite type, an array, a plain scalar, a domain over json, and a column
 * whose type is not known at all (a function's result) -- is converted first, exactly as PostgREST
 * does (`Plan.hs`, `resolveTypeOrUnknown`). It leaves json columns alone on purpose: wrapping them
 * would stop their indexes from being used.
 */
const needsJsonb = (type: string | undefined): boolean => type !== "json" && type !== "jsonb";

/** `"alias"."column"->'a'->>'b'`, or `to_jsonb("alias"."column")->'a'` for a non-json column. */
export const fieldSql = (alias: string, field: FieldRef, rel?: Relation): string => {
  const column = `${quoteIdent(alias)}.${quoteIdent(field.name)}`;
  if (field.json.length === 0) return column;
  let sql = needsJsonb(declaredType(rel, field.name)) ? `to_jsonb(${column})` : column;
  for (const step of field.json) {
    sql += ` ${step.arrow} ${step.isIndex ? String(Number(step.key)) : literal(step.key)}`;
  }
  return sql;
};

const JSON_TYPE = /^jsonb?(\[\])*$/i;

/**
 * A value to compare with a column, as a literal or as a bound parameter. A parameter takes the
 * type of what it is compared with, which is what a literal does too -- except for json and jsonb,
 * which some drivers (`Bun.sql`) then re-encode as JSON: those, and a column the relation does not
 * know the type of, stay literals. A value compared with the result of a JSON path takes
 * the type of that path: text for `->>` (bound), jsonb for `->` (a literal).
 */
const scalarSql = (value: string, field: FieldRef, rel: Relation | undefined, values: Values): string => {
  // the result of a JSON path has the type of its last step: text for `->>`, jsonb for `->`
  if (field.json.length > 0)
    return field.json[field.json.length - 1]!.arrow === "->>" ? values.sql(value) : literal(value);
  const type = declaredType(rel, field.name);
  if (type === undefined || JSON_TYPE.test(type)) return literal(value);
  return values.sql(value);
};

/**
 * The right-hand side of a comparison. A composite column compared against a JSON object takes it
 * as the fields of a row of its own type: `json_populate_record` builds that row, so the fields may
 * come in any order and the missing ones are NULL, exactly like a JSON body of an insert.
 *
 * This is what `query({ where: { item: { name: "sock" } } })` carries. A bare row literal
 * (`item=eq.(sock,17)`) is left alone: Postgres cannot read one without a type, and PostgREST
 * answers `0A000` for it, so that stays as it is.
 */
const valueSql = (value: string, field: FieldRef, rel: Relation | undefined, values: Values): string => {
  const column = field.json.length === 0 ? rel?.columns.find((c) => c.name === field.name) : undefined;
  if (!column?.composite || column.type.trim().endsWith("[]") || !value.trimStart().startsWith("{")) {
    return scalarSql(value, field, rel, values);
  }
  const type = quoteQualified(column.composite.schema, column.composite.name);
  return `json_populate_record(null::${type}, (${literal(value)})::json)`;
};

const COMPARISON: Partial<Record<Operator, string>> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
  ilike: "ILIKE",
  match: "~",
  imatch: "~*",
  cs: "@>",
  cd: "<@",
  ov: "&&",
  sl: "<<",
  sr: ">>",
  nxl: "&>",
  nxr: "&<",
  adj: "-|-",
};

const FTS_FUNCTIONS: Partial<Record<Operator, string>> = {
  fts: "to_tsquery",
  plfts: "plainto_tsquery",
  phfts: "phraseto_tsquery",
  wfts: "websearch_to_tsquery",
};

const patternValue = (op: Operator, v: string): string => (op === "like" || op === "ilike" ? v.replace(/\*/g, "%") : v);

/** SQL boolean expression for one filter. */
export const filterSql = (f: Filter, alias: string, rel: Relation | undefined, values: Values): string => {
  const lhs = fieldSql(alias, f.field, rel);
  let expr: string;

  switch (f.op) {
    case "in": {
      const list = f.value as ReadonlyArray<string>;
      expr =
        list.length === 0 ? "FALSE" : `${lhs} IN (${list.map((v) => valueSql(v, f.field, rel, values)).join(", ")})`;
      break;
    }
    case "is": {
      switch (f.value) {
        case "null":
          expr = `${lhs} IS NULL`;
          break;
        case "not_null":
          expr = `${lhs} IS NOT NULL`;
          break;
        case "true":
          expr = `${lhs} IS TRUE`;
          break;
        case "false":
          expr = `${lhs} IS FALSE`;
          break;
        default:
          expr = `${lhs} IS UNKNOWN`;
      }
      break;
    }
    case "isdistinct":
      expr = `${lhs} IS DISTINCT FROM ${valueSql(f.value as string, f.field, rel, values)}`;
      break;
    case "fts":
    case "plfts":
    case "phfts":
    case "wfts": {
      const fn = FTS_FUNCTIONS[f.op]!;
      const cfg = f.lang ? `${literal(f.lang)}, ` : "";
      // PostgREST applies to_tsvector() when the column is not already a tsvector -- a JSON path
      // into one does not change that: the column's own type is what it looks at.
      const vector = declaredType(rel, f.field.name) === "tsvector" ? lhs : `to_tsvector(${cfg}${lhs})`;
      expr = `${vector} @@ ${fn}(${cfg}${scalarSql(f.value as string, f.field, rel, values)})`;
      break;
    }
    default: {
      const sqlOp = COMPARISON[f.op]!;
      const value = patternValue(f.op, f.value as string);
      expr = f.quantifier
        ? `${lhs} ${sqlOp} ${f.quantifier.toUpperCase()} (${scalarSql(value, f.field, rel, values)})`
        : `${lhs} ${sqlOp} ${valueSql(value, f.field, rel, values)}`;
    }
  }
  return f.negate ? `NOT (${expr})` : expr;
};

export const nodeSql = (node: FilterNode, alias: string, rel: Relation | undefined, values: Values): string => {
  if (node.kind === "filter") return filterSql(node, alias, rel, values);
  const joiner = node.op === "and" ? " AND " : " OR ";
  const inner = node.children.map((c) => nodeSql(c, alias, rel, values)).join(joiner);
  const wrapped = `(${inner})`;
  return node.negate ? `NOT ${wrapped}` : wrapped;
};

export const orderSql = (terms: ReadonlyArray<OrderTerm>, alias: string, rel?: Relation): string => {
  if (terms.length === 0) return "";
  const parts = terms.map((t) => {
    if (t.relation) {
      throw new EngineError(
        "not_implemented",
        "Ordering by a column of a related table is not implemented yet",
        null,
        null,
      );
    }
    const nulls = t.nulls ? ` NULLS ${t.nulls.toUpperCase()}` : "";
    return `${fieldSql(alias, t.field, rel)} ${t.dir.toUpperCase()}${nulls}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
};

export const whereSql = (
  nodes: ReadonlyArray<FilterNode>,
  alias: string,
  rel: Relation | undefined,
  values: Values,
): string[] => nodes.map((n) => nodeSql(n, alias, rel, values));
