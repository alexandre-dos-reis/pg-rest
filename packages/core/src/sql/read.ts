import { EngineError } from "../errors";
import type { NodeParams, ParsedQuery } from "../parse/filter";
import { outputName, type AggregateItem, type EmbedItem, type FieldItem, type SelectItem } from "../parse/select";
import { quoteIdent, quoteQualified } from "../quote";
import { type Relation, type SchemaCache, resolveRelationship } from "../schema";
import type { OrderTerm } from "../parse/filter";
import { fieldSql, whereSql } from "./filters";
import { type Values, inlined } from "./values";

export const ROOT_ALIAS = "pgrst_root";

export interface ReadOptions {
  readonly cache: SchemaCache;
  readonly rel: Relation;
  /** The row source, without alias: `"api"."clients"`, a CTE name or `(subquery)`. */
  readonly from: string;
  readonly query: ParsedQuery;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  /** How a filter's value gets into the SQL; literals when not given. */
  readonly values?: Values | undefined;
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
  readonly values: Values;
}

const fieldExpr = (item: FieldItem, alias: string, rel: Relation): string => {
  const base = fieldSql(alias, item.field, rel);
  const expr = item.cast ? `${base}::${item.cast}` : base;
  const plain = !item.cast && item.field.json.length === 0 && !item.alias;
  return plain ? expr : `${expr} AS ${quoteIdent(outputName(item))}`;
};

const aggregateExpr = (item: AggregateItem, alias: string, rel: Relation): string => {
  const arg = item.field ? fieldSql(alias, item.field, rel) : "*";
  let expr = `${item.fn}(${arg})`;
  if (item.cast) expr = `(${expr})::${item.cast}`;
  return `${expr} AS ${quoteIdent(outputName(item))}`;
};

/** Output column names produced by a list of select items (used for spreads). */
const itemNames = (ctx: Ctx, items: ReadonlyArray<SelectItem>, rel: Relation): string[] => {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === "star") out.push(...rel.columns.map((c) => c.name));
    else if (it.kind === "field" || it.kind === "aggregate") out.push(outputName(it));
    else if (it.items.length === 0) continue;
    else if (it.spread)
      out.push(...itemNames(ctx, it.items, resolveRelationship(ctx.cache, rel, it.target, it.hint).to));
    else out.push(it.alias ?? it.target);
  }
  return out;
};

const orderClause = (
  ctx: Ctx,
  terms: ReadonlyArray<OrderTerm>,
  rel: Relation,
  alias: string,
  items: ReadonlyArray<SelectItem>,
): string => {
  if (terms.length === 0) return "";
  const q = quoteIdent;
  const parts = terms.map((t) => {
    const tail = `${t.dir.toUpperCase()}${t.nulls ? ` NULLS ${t.nulls.toUpperCase()}` : ""}`;
    if (!t.relation) return `${fieldSql(alias, t.field, rel)} ${tail}`;
    const embed = items.find((i): i is EmbedItem => i.kind === "embed" && (i.alias ?? i.target) === t.relation);
    if (!embed) {
      throw new EngineError(
        "not_embedded",
        `'${t.relation}' is not an embedded resource in this request`,
        null,
        `Verify that '${t.relation}' is included in the 'select' query parameter.`,
      );
    }
    const r = resolveRelationship(ctx.cache, rel, embed.target, embed.hint);
    if (r.kind !== "m2o" && r.kind !== "o2o") {
      throw new EngineError(
        "invalid_related_order",
        `A related order on '${t.relation}' is not possible`,
        `'${rel.name}' and '${embed.target}' do not form a many-to-one or one-to-one relationship`,
        null,
      );
    }
    // PostgREST orders by the embedded query's output, so the column has to be selected there
    const selected = embed.items.filter((i) => i.kind !== "embed");
    if (
      selected.length > 0 &&
      !selected.some((i) => i.kind === "star" || (i.kind === "field" && i.field.name === t.field.name))
    ) {
      throw new EngineError(
        "undefined_column",
        `column ${rel.name}_${embed.target}_1.${t.field.name} does not exist`,
        null,
        null,
      );
    }
    const o = ctx.aliases.next("pgrst_o");
    if (r.computed) {
      return `(SELECT ${fieldSql(o, t.field, r.to)} FROM ${quoteQualified(r.computed.schema, r.computed.name)}(${q(alias)}) AS ${q(o)} LIMIT 1) ${tail}`;
    }
    const cond = r.toCols.map((c, i) => `${q(o)}.${q(c)} = ${q(alias)}.${q(r.fromCols[i]!)}`).join(" AND ");
    return `(SELECT ${fieldSql(o, t.field, r.to)} FROM ${quoteQualified(r.to.schema, r.to.name)} AS ${q(o)} WHERE ${cond} LIMIT 1) ${tail}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
};

const buildItems = (
  ctx: Ctx,
  items: ReadonlyArray<SelectItem>,
  rel: Relation,
  alias: string,
  path: string[],
): Built => {
  const cols: string[] = [];
  const joins: Join[] = [];
  const groupBy: string[] = [];
  const aggregated = items.some((i) => i.kind === "aggregate");

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
        cols.push(fieldExpr(item, alias, rel));
        if (aggregated) groupBy.push(fieldSql(alias, item.field, rel));
        break;
      case "aggregate":
        cols.push(aggregateExpr(item, alias, rel));
        break;
      case "embed": {
        const e = buildEmbed(ctx, item, rel, alias, path);
        cols.push(...e.cols);
        joins.push(e.join);
        if (aggregated) groupBy.push(...e.group);
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
      throw new EngineError(
        "not_embedded",
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
): { cols: string[]; join: Join; group: string[] } => {
  const relationship = resolveRelationship(ctx.cache, parentRel, item.target, item.hint);
  const name = item.alias ?? item.target;
  const childPath = [...path, name];
  const params = ctx.query.embeds.get(childPath.join("."));
  const toOne = relationship.kind === "m2o" || relationship.kind === "o2o";
  const child = relationship.to;
  const cAlias = ctx.aliases.next(`${child.name}_`);
  const eAlias = ctx.aliases.next("pgrst_j");
  const inner = buildItems(ctx, item.items, child, cAlias, childPath);
  const hasCols = inner.cols.length > 0;

  const q = quoteIdent;
  const conds: string[] = [];
  let from: string;
  if (relationship.computed) {
    const fn = relationship.computed;
    from = `${quoteQualified(fn.schema, fn.name)}(${q(parentAlias)}) AS ${q(cAlias)}`;
    conds.push("TRUE");
  } else if (relationship.junction) {
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

  conds.push(...(params ? whereSql(params.filters, cAlias, child, ctx.values) : []));
  conds.push(...presenceConditions(params, inner.joins));

  const order = params ? orderClause(ctx, params.order, child, cAlias, item.items) : "";
  const page = paging(params?.limit, params?.offset);
  const sel = hasCols ? inner.cols.join(", ") : "1";
  const groupSql = inner.aggregated && inner.groupBy.length ? ` GROUP BY ${inner.groupBy.join(", ")}` : "";
  const body = `SELECT ${sel} FROM ${from} WHERE ${conds.join(" AND ")}${groupSql}${order ? ` ${order}` : ""}${page}`;
  // PostgREST embeds with jsonb (key order and spacing are visible in CSV output)
  const J = "jsonb";

  const joinKw = item.join === "inner" ? "JOIN LATERAL" : "LEFT JOIN LATERAL";

  if (item.spread) {
    const names = itemNames(ctx, item.items, child);
    if (toOne) {
      const lateral = `${joinKw} (${body}${page ? "" : " LIMIT 1"}) AS ${q(eAlias)} ON TRUE`;
      const refs = names.map((n) => `${q(eAlias)}.${q(n)}`);
      return {
        cols: names.map((n, i) => `${refs[i]} AS ${q(n)}`),
        join: { sql: lateral, alias: eAlias, name, inner: item.join === "inner" },
        group: refs,
      };
    }
    if (inner.aggregated) {
      throw new EngineError(
        "not_implemented",
        "Feature not implemented",
        "Aggregates are not implemented for one-to-many or many-to-many spreads.",
        null,
      );
    }
    // to-many spread: every column becomes an array with one entry per related row
    const agg = names.map((n) => `coalesce(${J}_agg(_r.${q(n)}), '[]'::${J}) AS ${q(n)}`).join(", ");
    const having = item.join === "inner" ? " HAVING count(*) > 0" : "";
    const lateral = `${joinKw} (SELECT ${agg || "1"} FROM (${body}) AS _r${having}) AS ${q(eAlias)} ON TRUE`;
    const refs = names.map((n) => `${q(eAlias)}.${q(n)}`);
    return {
      cols: names.map((n, i) => `${refs[i]} AS ${q(n)}`),
      join: { sql: lateral, alias: eAlias, name, inner: item.join === "inner" },
      group: refs,
    };
  }

  if (toOne) {
    const lateral = `${joinKw} (SELECT to_${J}(_r) AS j FROM (${body}) AS _r LIMIT 1) AS ${q(eAlias)} ON TRUE`;
    return {
      cols: hasCols ? [`${q(eAlias)}.j AS ${q(name)}`] : [],
      join: { sql: lateral, alias: eAlias, name, inner: item.join === "inner" },
      group: hasCols ? [`${q(eAlias)}.j`] : [],
    };
  }

  const having = item.join === "inner" ? " HAVING count(*) > 0" : "";
  const lateral = `${joinKw} (SELECT ${J}_agg(_r) AS j FROM (${body}) AS _r${having}) AS ${q(eAlias)} ON TRUE`;
  return {
    cols: hasCols ? [`coalesce(${q(eAlias)}.j, '[]'::${J}) AS ${q(name)}`] : [],
    join: { sql: lateral, alias: eAlias, name, inner: item.join === "inner" },
    group: hasCols ? [`${q(eAlias)}.j`] : [],
  };
};

/** Build the SELECT (and matching COUNT) for a read. */
export const buildRead = (opts: ReadOptions): ReadSql => {
  const ctx: Ctx = { cache: opts.cache, query: opts.query, aliases: new Aliases(), values: opts.values ?? inlined };
  const built = buildItems(ctx, opts.query.select, opts.rel, ROOT_ALIAS, []);

  const where = [
    ...whereSql(opts.query.root.filters, ROOT_ALIAS, opts.rel, ctx.values),
    ...presenceConditions(opts.query.root, built.joins),
  ];
  const whereClause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const fromClause = `${opts.from} AS ${quoteIdent(ROOT_ALIAS)}`;
  const joinSql = built.joins.map((j) => j.sql).join(" ");
  const groupClause = built.aggregated && built.groupBy.length ? ` GROUP BY ${built.groupBy.join(", ")}` : "";
  const order = orderClause(ctx, opts.query.root.order, opts.rel, ROOT_ALIAS, opts.query.select);

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
