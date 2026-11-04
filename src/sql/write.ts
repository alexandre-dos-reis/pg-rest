import { PgRestError } from "../errors";
import type { FilterNode } from "../parse/filter";
import { quoteIdent, quoteQualified } from "../quote";
import type { Relation } from "../schema";
import { whereSql } from "./filters";
import { ROOT_ALIAS } from "./read";

export type JsonObject = Record<string, unknown>;

/** What the data-modifying statement should RETURN. */
export type Returning = "representation" | "pk" | "minimal";

const returningSql = (rel: Relation, returning: Returning): string => {
  const alias = quoteIdent(ROOT_ALIAS);
  if (returning === "representation") return `${alias}.*`;
  if (returning === "pk" && rel.pk.length > 0) return rel.pk.map((c) => `${alias}.${quoteIdent(c)}`).join(", ");
  return "1";
};

const columnNotFound = (rel: Relation, column: string) =>
  new PgRestError(
    400,
    "PGRST204",
    `Could not find the '${column}' column of '${rel.name}' in the schema cache`,
    null,
    null,
  );

const checkColumns = (rel: Relation, cols: ReadonlyArray<string>): void => {
  const known = new Set(rel.columns.map((c) => c.name));
  for (const c of cols) if (!known.has(c)) throw columnNotFound(rel, c);
};

const unionKeys = (rows: ReadonlyArray<JsonObject>): string[] => {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
};

export interface InsertOptions {
  readonly rel: Relation;
  readonly rows: ReadonlyArray<JsonObject>;
  /** `columns=` query parameter: restrict which keys of the payload are used. */
  readonly columns?: ReadonlyArray<string> | undefined;
  readonly onConflict?: ReadonlyArray<string> | undefined;
  readonly resolution?: "merge-duplicates" | "ignore-duplicates" | undefined;
  readonly missingDefault?: boolean | undefined;
  /** Flag really-inserted rows (`pgrst_inserted`) of a merge-duplicates upsert; see `upsertColumns`. */
  readonly flagInserted?: boolean | undefined;
  readonly returning: Returning;
}

/**
 * `INSERT … RETURNING …`. The payload is `$1` (JSON text, an array of objects);
 * it is always cast through `$1::text` so the driver never re-encodes it.
 */
export const buildInsert = (o: InsertOptions): string => {
  const { rel } = o;
  const table = quoteQualified(rel.schema, rel.name);
  const target = `${table} AS ${quoteIdent(ROOT_ALIAS)}`;
  const returning = returningSql(rel, o.returning);
  const cols = o.columns ? [...o.columns] : unionKeys(o.rows);
  if (!o.columns && o.rows.some((r) => Object.keys(r).length !== cols.length)) {
    throw new PgRestError(400, "PGRST102", "All object keys must match");
  }
  checkColumns(rel, cols);

  if (cols.length === 0) {
    // Only empty objects: insert default rows.
    const first = rel.columns[0];
    if (!first) throw new PgRestError(400, "PGRST102", "Cannot insert into a relation without columns");
    const values = o.rows.map(() => "(DEFAULT)").join(", ");
    return `INSERT INTO ${target} (${quoteIdent(first.name)}) VALUES ${values || "(DEFAULT)"} RETURNING ${returning}`;
  }

  const colList = cols.map(quoteIdent).join(", ");
  const typed = `null::${table}`;
  const json = "($1::text)::json";

  let select: string;
  if (o.missingDefault) {
    const byName = new Map(rel.columns.map((c) => [c.name, c]));
    const exprs = cols.map((c) => {
      const allPresent = o.rows.every((r) => c in r);
      const value = `_p.${quoteIdent(c)}`;
      if (allPresent) return value;
      const dflt = byName.get(c)?.defaultExpr ?? "NULL";
      return `CASE WHEN (_e.value::jsonb) ? ${"'" + c.replace(/'/g, "''") + "'"} THEN ${value} ELSE ${dflt} END`;
    });
    select = `SELECT ${exprs.join(", ")} FROM json_array_elements(${json}) AS _e(value) CROSS JOIN LATERAL json_populate_record(${typed}, _e.value) AS _p`;
  } else {
    select = `SELECT ${colList} FROM json_populate_recordset(${typed}, ${json})`;
  }

  let conflict = "";
  if (o.resolution) {
    const keys = o.onConflict && o.onConflict.length > 0 ? o.onConflict : rel.pk;
    checkColumns(rel, keys);
    const targetCols = keys.length ? ` (${keys.map(quoteIdent).join(", ")})` : "";
    if (o.resolution === "ignore-duplicates") {
      conflict = ` ON CONFLICT${targetCols} DO NOTHING`;
    } else {
      if (keys.length === 0) {
        throw new PgRestError(
          400,
          "PGRST100",
          "Upsert needs a conflict target",
          `"${rel.name}" has no primary key; pass on_conflict=<columns>`,
        );
      }
      conflict = ` ON CONFLICT${targetCols} DO UPDATE SET ${cols
        .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
        .join(", ")}`;
    }
  } else if (o.onConflict && o.onConflict.length > 0) {
    // on_conflict without a resolution preference has no effect (as in PostgREST).
  }

  // A merge-duplicates upsert flags which rows were really inserted (xmax = 0), so the
  // response can be 200 instead of 201 when it only updated existing rows.
  const flag = o.flagInserted && o.resolution === "merge-duplicates" ? `, (${quoteIdent(ROOT_ALIAS)}.xmax = 0) AS pgrst_inserted` : "";
  const ret = flag && returning === "1" ? "1 AS pgrst_one" : returning;
  return `INSERT INTO ${target} (${colList}) ${select}${conflict} RETURNING ${ret}${flag}`;
};

/** Columns of `buildInsert`'s output without the `pgrst_inserted` marker, for a merge-duplicates upsert. */
export const upsertColumns = (rel: Relation, returning: Returning): string[] => {
  if (returning === "representation") return rel.columns.map((c) => quoteIdent(c.name));
  if (returning === "pk" && rel.pk.length > 0) return rel.pk.map(quoteIdent);
  return ["pgrst_one"];
};

export interface UpdateOptions {
  readonly rel: Relation;
  readonly body: JsonObject;
  readonly filters: ReadonlyArray<FilterNode>;
  readonly returning: Returning;
}

/** `UPDATE … SET … RETURNING …`, or `null` when the payload sets no columns. */
export const buildUpdate = (o: UpdateOptions): string | null => {
  const { rel } = o;
  const cols = Object.keys(o.body);
  checkColumns(rel, cols);
  if (cols.length === 0) return null;
  const table = quoteQualified(rel.schema, rel.name);
  const set = cols.map((c) => `${quoteIdent(c)} = _u.${quoteIdent(c)}`).join(", ");
  const where = whereSql(o.filters, ROOT_ALIAS, rel);
  return (
    `UPDATE ${table} AS ${quoteIdent(ROOT_ALIAS)} SET ${set} ` +
    `FROM (SELECT * FROM json_populate_record(null::${table}, ($1::text)::json)) AS _u` +
    `${where.length ? ` WHERE ${where.join(" AND ")}` : ""} RETURNING ${returningSql(rel, o.returning)}`
  );
};

export interface DeleteOptions {
  readonly rel: Relation;
  readonly filters: ReadonlyArray<FilterNode>;
  readonly returning: Returning;
}

export const buildDelete = (o: DeleteOptions): string => {
  const where = whereSql(o.filters, ROOT_ALIAS, o.rel);
  return (
    `DELETE FROM ${quoteQualified(o.rel.schema, o.rel.name)} AS ${quoteIdent(ROOT_ALIAS)}` +
    `${where.length ? ` WHERE ${where.join(" AND ")}` : ""} RETURNING ${returningSql(o.rel, o.returning)}`
  );
};
