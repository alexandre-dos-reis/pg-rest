import { PgRestError } from "../errors";
import type { NodeParams, ParsedQuery } from "../parse/filter";
import { outputName, type AggregateItem, type EmbedItem, type FieldItem, type SelectItem } from "../parse/select";
import { quoteIdent, quoteQualified } from "../quote";
import { type Relation, type SchemaCache, resolveRelationship } from "../schema";
import { fieldSql, orderSql, whereSql } from "./filters";

export const ROOT_ALIAS = "pgrst_root";

export interface ReadOptions {
  readonly cache: SchemaCache;
  readonly rel: Relation;
  /** The row source, without alias: `"api"."clients"`, a CTE name or `(subquery)`. */
  readonly from: string;
  readonly query: ParsedQuery;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface ReadSql {
  /** The row-producing SELECT (with ORDER/LIMIT/OFFSET). */
  readonly rows: string;
  /** `SELECT count(*) …` over the same rows without paging. */
  readonly count: string;
  /** The row-producing SELECT without ORDER/LIMIT/OFFSET (used for planner estimates). */
  readonly unpaged: string;
}

interface Join {
  readonly sql: string;
  readonly alias: string;
  /** Name (alias or target) used to match `?embed=is.null` filters. */
  readonly name: string;
  readonly inner: boolean;
}

interface Built {
  readonly cols: string[];
  readonly joins: Join[];
  readonly groupBy: string[];
  readonly aggregated: boolean;
}

class Aliases {
  private n = 0;
  next(prefix: string): string {
    return `${prefix}${++this.n}`;
  }
}

interface Ctx {
  readonly cache: SchemaCache;
  readonly query: ParsedQuery;
  readonly aliases: Aliases;
}

const notImplemented = (what: string) =>
  new PgRestError(400, "PGRST127", `${what} is not implemented`, null, null);

const fieldExpr = (item: FieldItem, alias: string): string => {
  const base = fieldSql(alias, item.field);
  const expr = item.cast ? `${base}::${item.cast}` : base;
  const plain = !item.cast && item.field.json.length === 0 && !item.alias;
  return plain ? expr : `${expr} AS ${quoteIdent(outputName(item))}`;
};

const aggregateExpr = (item: AggregateItem, alias: string): string => {
  const arg = item.field ? fieldSql(alias, item.field) : "*";
  let expr = `${item.fn}(${arg})`;
  if (item.cast) expr = `(${expr})::${item.cast}`;
  return `${expr} AS ${quoteIdent(outputName(item))}`;
};

/** Output column names produced by a list of non-embed items (used for spreads). */
const plainOutputNames = (items: ReadonlyArray<SelectItem>, rel: Relation): string[] => {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === "star") out.push(...rel.columns.map((c) => c.name));
    else if (it.kind === "field") out.push(outputName(it));
    else throw notImplemented("Spreading an embedded resource that contains aggregates or embeds");
  }
  return out;
};

const buildItems = (
  ctx: Ctx,
  items: ReadonlyArray<SelectItem>,
  rel: Relation,
  alias: string,
  path: string[],
  isRoot: boolean,
): Built => {
  const cols: string[] = [];
  const joins: Join[] = [];
  const groupBy: string[] = [];
  const aggregated = items.some((i) => i.kind === "aggregate");

  if (aggregated && !isRoot) throw notImplemented("Aggregate functions in embedded resources");
  if (aggregated && items.some((i) => i.kind === "embed")) {
    throw notImplemented("Combining aggregate functions with embedded resources");
  }

  for (const item of items) {
    switch (item.kind) {
      case "star":
        if (aggregated) {
          for (const c of rel.columns) {
            const e = `${quoteIdent(alias)}.${quoteIdent(c.name)}`;
            cols.push(e);
            groupBy.push(e);
          }
        } else cols.push(`${quoteIdent(alias)}.*`);
        break;
      case "field":
        cols.push(fieldExpr(item, alias));
        if (aggregated) groupBy.push(fieldSql(alias, item.field));
        break;
      case "aggregate":
        cols.push(aggregateExpr(item, alias));
        break;
      case "embed": {
        const e = buildEmbed(ctx, item, rel, alias, path);
        cols.push(...e.cols);
        joins.push(e.join);
        break;
      }
    }
  }
  return { cols, joins, groupBy, aggregated };
};

const presenceConditions = (params: NodeParams | undefined, joins: ReadonlyArray<Join>): string[] =>
  (params?.presence ?? []).map((p) => {
    const j = joins.find((x) => x.name === p.embed);
    if (!j) {
      throw new PgRestError(
        400,
        "PGRST108",
        `'${p.embed}' is not an embedded resource in this request`,
        null,
        `Verify that '${p.embed}' is included in the 'select' query parameter.`,
      );
    }
    return `${quoteIdent(j.alias)}.j IS ${p.present ? "NOT " : ""}NULL`;
  });

const paging = (limit: number | undefined, offset: number | undefined): string => {
  let s = "";
  if (limit !== undefined) s += ` LIMIT ${Math.trunc(limit)}`;
  if (offset !== undefined && offset > 0) s += ` OFFSET ${Math.trunc(offset)}`;
  return s;
};

const buildEmbed = (
  ctx: Ctx,
  item: EmbedItem,
  parentRel: Relation,
  parentAlias: string,
  path: string[],
): { cols: string[]; join: Join } => {
  const relationship = resolveRelationship(ctx.cache, parentRel, item.target, item.hint);
  const name = item.alias ?? item.target;
  const childPath = [...path, name];
  const params = ctx.query.embeds.get(childPath.join("."));
  const toOne = relationship.kind === "m2o" || relationship.kind === "o2o";
  if (item.spread && !toOne) throw notImplemented("Spreading a to-many embedded resource");

  const child = relationship.to;
  const cAlias = ctx.aliases.next("pgrst_c");
  const eAlias = ctx.aliases.next("pgrst_j");
  const inner = buildItems(ctx, item.items, child, cAlias, childPath, false);
  const hasCols = inner.cols.length > 0;

  const q = quoteIdent;
  const conds: string[] = [];
  let from: string;
  if (relationship.junction) {
    const j = relationship.junction;
    const jAlias = ctx.aliases.next("pgrst_m");
    const onTo = j.fkTo.cols.map((c, i) => `${q(jAlias)}.${q(c)} = ${q(cAlias)}.${q(j.fkTo.fcols[i]!)}`);
    from = `${quoteQualified(child.schema, child.name)} AS ${q(cAlias)} JOIN ${quoteQualified(j.relation.schema, j.relation.name)} AS ${q(jAlias)} ON ${onTo.join(" AND ")}`;
    conds.push(...j.fkFrom.cols.map((c, i) => `${q(jAlias)}.${q(c)} = ${q(parentAlias)}.${q(j.fkFrom.fcols[i]!)}`));
  } else {
    from = `${quoteQualified(child.schema, child.name)} AS ${q(cAlias)}`;
    conds.push(
      ...relationship.toCols.map((c, i) => `${q(cAlias)}.${q(c)} = ${q(parentAlias)}.${q(relationship.fromCols[i]!)}`),
    );
  }
  if (inner.joins.length) from += ` ${inner.joins.map((j) => j.sql).join(" ")}`;

  conds.push(...(params ? whereSql(params.filters, cAlias, child) : []));
  conds.push(...presenceConditions(params, inner.joins));

  const order = params ? orderSql(params.order, cAlias) : "";
  const page = paging(params?.limit, params?.offset);
  const sel = hasCols ? inner.cols.join(", ") : "1";
  const body = `SELECT ${sel} FROM ${from} WHERE ${conds.join(" AND ")}${order ? ` ${order}` : ""}${page}`;

  const joinKw = item.join === "inner" ? "JOIN LATERAL" : "LEFT JOIN LATERAL";

  if (item.spread) {
    const names = plainOutputNames(item.items, child);
    const lateral = `${joinKw} (${body}${page ? "" : " LIMIT 1"}) AS ${q(eAlias)} ON TRUE`;
    return {
      cols: names.map((n) => `${q(eAlias)}.${q(n)} AS ${q(n)}`),
      join: { sql: lateral, alias: eAlias, name, inner: item.join === "inner" },
    };
  }

  if (toOne) {
    const lateral = `${joinKw} (SELECT to_json(_r) AS j FROM (${body}) AS _r LIMIT 1) AS ${q(eAlias)} ON TRUE`;
    return {
      cols: hasCols ? [`${q(eAlias)}.j AS ${q(name)}`] : [],
      join: { sql: lateral, alias: eAlias, name, inner: item.join === "inner" },
    };
  }

  const having = item.join === "inner" ? " HAVING count(*) > 0" : "";
  const lateral = `${joinKw} (SELECT json_agg(_r) AS j FROM (${body}) AS _r${having}) AS ${q(eAlias)} ON TRUE`;
  return {
    cols: hasCols ? [`coalesce(${q(eAlias)}.j, '[]'::json) AS ${q(name)}`] : [],
    join: { sql: lateral, alias: eAlias, name, inner: item.join === "inner" },
  };
};

/** Build the SELECT (and matching COUNT) for a read request. */
export const buildRead = (opts: ReadOptions): ReadSql => {
  const ctx: Ctx = { cache: opts.cache, query: opts.query, aliases: new Aliases() };
  const built = buildItems(ctx, opts.query.select, opts.rel, ROOT_ALIAS, [], true);

  const where = [
    ...whereSql(opts.query.root.filters, ROOT_ALIAS, opts.rel),
    ...presenceConditions(opts.query.root, built.joins),
  ];
  const whereClause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const fromClause = `${opts.from} AS ${quoteIdent(ROOT_ALIAS)}`;
  const joinSql = built.joins.map((j) => j.sql).join(" ");
  const groupClause = built.aggregated && built.groupBy.length ? ` GROUP BY ${built.groupBy.join(", ")}` : "";
  const order = orderSql(opts.query.root.order, ROOT_ALIAS);

  const cols = built.cols.length ? built.cols.join(", ") : "1";
  const unpaged = `SELECT ${cols} FROM ${fromClause}${joinSql ? ` ${joinSql}` : ""}${whereClause}${groupClause}`;
  const rows = `${unpaged}${order ? ` ${order}` : ""}${paging(opts.limit, opts.offset)}`;

  let count: string;
  if (built.aggregated) {
    count = `SELECT count(*) FROM (${unpaged}) AS _c`;
  } else if (built.joins.some((j) => j.inner) || (opts.query.root.presence.length ?? 0) > 0) {
    count = `SELECT count(*) FROM ${fromClause} ${joinSql}${whereClause}`;
  } else {
    count = `SELECT count(*) FROM ${fromClause}${whereClause}`;
  }
  return { rows, count, unpaged };
};
