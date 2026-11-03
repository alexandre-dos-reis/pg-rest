import { PgRestError } from "../errors";
import type { FieldRef } from "../parse/field";
import type { Filter, FilterNode, Operator, OrderTerm } from "../parse/filter";
import { literal, quoteIdent } from "../quote";
import type { Relation } from "../schema";

/** `"alias"."column"->'a'->>'b'` */
export const fieldSql = (alias: string, field: FieldRef): string => {
  let sql = `${quoteIdent(alias)}.${quoteIdent(field.name)}`;
  for (const step of field.json) {
    sql += ` ${step.arrow} ${step.isIndex ? String(Number(step.key)) : literal(step.key)}`;
  }
  return sql;
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

const columnType = (rel: Relation | undefined, field: FieldRef): string | undefined =>
  field.json.length === 0 ? rel?.columns.find((c) => c.name === field.name)?.type : undefined;

const patternValue = (op: Operator, v: string): string =>
  op === "like" || op === "ilike" ? v.replace(/\*/g, "%") : v;

/** SQL boolean expression for one filter. */
export const filterSql = (f: Filter, alias: string, rel?: Relation): string => {
  const lhs = fieldSql(alias, f.field);
  let expr: string;

  switch (f.op) {
    case "in": {
      const list = f.value as ReadonlyArray<string>;
      expr = list.length === 0 ? "FALSE" : `${lhs} IN (${list.map(literal).join(", ")})`;
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
      expr = `${lhs} IS DISTINCT FROM ${literal(f.value as string)}`;
      break;
    case "fts":
    case "plfts":
    case "phfts":
    case "wfts": {
      const fn = FTS_FUNCTIONS[f.op]!;
      const cfg = f.lang ? `${literal(f.lang)}, ` : "";
      // PostgREST applies to_tsvector() when the column is not already a tsvector.
      const vector = columnType(rel, f.field) === "tsvector" ? lhs : `to_tsvector(${cfg}${lhs})`;
      expr = `${vector} @@ ${fn}(${cfg}${literal(f.value as string)})`;
      break;
    }
    default: {
      const sqlOp = COMPARISON[f.op]!;
      const value = patternValue(f.op, f.value as string);
      expr = f.quantifier
        ? `${lhs} ${sqlOp} ${f.quantifier.toUpperCase()} (${literal(value)})`
        : `${lhs} ${sqlOp} ${literal(value)}`;
    }
  }
  return f.negate ? `NOT (${expr})` : expr;
};

export const nodeSql = (node: FilterNode, alias: string, rel?: Relation): string => {
  if (node.kind === "filter") return filterSql(node, alias, rel);
  const joiner = node.op === "and" ? " AND " : " OR ";
  const inner = node.children.map((c) => nodeSql(c, alias, rel)).join(joiner);
  const wrapped = `(${inner})`;
  return node.negate ? `NOT ${wrapped}` : wrapped;
};

export const orderSql = (terms: ReadonlyArray<OrderTerm>, alias: string): string => {
  if (terms.length === 0) return "";
  const parts = terms.map((t) => {
    if (t.relation) {
      throw new PgRestError(
        400,
        "PGRST127",
        "Ordering by a column of a related table is not implemented yet",
        null,
        null,
      );
    }
    const nulls = t.nulls ? ` NULLS ${t.nulls.toUpperCase()}` : "";
    return `${fieldSql(alias, t.field)} ${t.dir.toUpperCase()}${nulls}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
};

export const whereSql = (
  nodes: ReadonlyArray<FilterNode>,
  alias: string,
  rel?: Relation,
): string[] => nodes.map((n) => nodeSql(n, alias, rel));
