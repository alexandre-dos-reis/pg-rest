import type { DbSession } from "./adapter";
import { PgRestError } from "./errors";
import { literal } from "./quote";

export interface Column {
  readonly name: string;
  /** Result of `format_type`, e.g. `integer`, `character varying(10)`, `text[]`. */
  readonly type: string;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  /** SQL text of the default expression, when there is one. */
  readonly defaultExpr: string | null;
  readonly generated: boolean;
  readonly comment: string | null;
  readonly position: number;
}

export type RelationKind = "table" | "view" | "matview" | "foreign" | "partitioned";

export interface Relation {
  readonly schema: string;
  readonly name: string;
  readonly kind: RelationKind;
  readonly columns: ReadonlyArray<Column>;
  readonly pk: ReadonlyArray<string>;
  readonly uniques: ReadonlyArray<ReadonlyArray<string>>;
  readonly insertable: boolean;
  readonly updatable: boolean;
  readonly deletable: boolean;
  readonly comment: string | null;
}

export interface ForeignKey {
  readonly name: string;
  readonly schema: string;
  readonly table: string;
  readonly cols: ReadonlyArray<string>;
  readonly fschema: string;
  readonly ftable: string;
  readonly fcols: ReadonlyArray<string>;
}

export interface FunctionArg {
  readonly name: string;
  readonly type: string;
  readonly hasDefault: boolean;
  readonly variadic: boolean;
}

export interface FunctionDef {
  readonly schema: string;
  readonly name: string;
  readonly args: ReadonlyArray<FunctionArg>;
  readonly returnType: string;
  readonly returnsSet: boolean;
  /** True if the function returns a composite / record / TABLE(...) row type. */
  readonly returnsComposite: boolean;
  readonly returnsVoid: boolean;
  readonly volatility: "immutable" | "stable" | "volatile";
  readonly comment: string | null;
}

export interface SchemaCache {
  readonly schemas: ReadonlyArray<string>;
  readonly relations: ReadonlyMap<string, Relation>;
  readonly foreignKeys: ReadonlyArray<ForeignKey>;
  readonly functions: ReadonlyMap<string, ReadonlyArray<FunctionDef>>;
}

export const relKey = (schema: string, name: string) => `${schema}.${name}`;

const kindOf = (k: string): RelationKind =>
  k === "v" ? "view" : k === "m" ? "matview" : k === "f" ? "foreign" : k === "p" ? "partitioned" : "table";

const schemaList = (schemas: ReadonlyArray<string>) => `ARRAY[${schemas.map(literal).join(",")}]::text[]`;

const asJson = (inner: string) => `SELECT coalesce(json_agg(r), '[]'::json)::text AS j FROM (${inner}) r`;

const run = async <T>(db: DbSession, sql: string): Promise<T[]> => {
  const rows = await db.query(asJson(sql));
  const j = rows[0]?.["j"];
  return JSON.parse(typeof j === "string" ? j : "[]") as T[];
};

/** Read the catalog and build a fresh {@link SchemaCache}. */
export const introspect = async (db: DbSession, schemas: ReadonlyArray<string>): Promise<SchemaCache> => {
  const S = schemaList(schemas);

  const relRows = await run<{
    schema: string;
    name: string;
    kind: string;
    comment: string | null;
    bits: number;
  }>(
    db,
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
            obj_description(c.oid, 'pg_class') AS comment,
            pg_relation_is_updatable(c.oid, true) AS bits
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY(${S})
        AND c.relkind IN ('r','v','m','f','p')
        AND NOT c.relispartition
      ORDER BY 1, 2`,
  );

  const colRows = await run<{
    schema: string;
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    has_default: boolean;
    default_expr: string | null;
    generated: boolean;
    comment: string | null;
    pos: number;
  }>(
    db,
    `SELECT n.nspname AS schema, c.relname AS "table", a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable,
            (a.atthasdef OR a.attidentity <> '') AS has_default,
            pg_get_expr(d.adbin, d.adrelid) AS default_expr,
            (a.attgenerated <> '') AS generated,
            col_description(c.oid, a.attnum) AS comment,
            a.attnum AS pos
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = ANY(${S})
        AND c.relkind IN ('r','v','m','f','p')
        AND NOT c.relispartition
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY 1, 2, a.attnum`,
  );

  const conRows = await run<{
    name: string;
    type: string;
    schema: string;
    table: string;
    cols: string[];
    fschema: string | null;
    ftable: string | null;
    fcols: string[] | null;
  }>(
    db,
    `SELECT con.conname AS name, con.contype::text AS type,
            ns.nspname AS schema, rel.relname AS "table",
            (SELECT json_agg(a.attname ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
            fns.nspname AS fschema, frel.relname AS ftable,
            (SELECT json_agg(a.attname ORDER BY k.ord)
               FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS fcols
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       LEFT JOIN pg_class frel ON frel.oid = con.confrelid
       LEFT JOIN pg_namespace fns ON fns.oid = frel.relnamespace
      WHERE con.contype IN ('p','u','f')
        AND con.conparentid = 0
        AND (ns.nspname = ANY(${S}) OR fns.nspname = ANY(${S}))`,
  );

  const fnRows = await run<{
    schema: string;
    name: string;
    returns_set: boolean;
    volatility: string;
    return_type: string;
    return_typtype: string;
    has_out: boolean;
    n_defaults: number;
    comment: string | null;
    args: Array<{ name: string; type: string; mode: string }>;
  }>(
    db,
    `SELECT n.nspname AS schema, p.proname AS name,
            p.proretset AS returns_set, p.provolatile::text AS volatility,
            format_type(p.prorettype, NULL) AS return_type,
            rt.typtype::text AS return_typtype,
            coalesce(p.proargmodes && ARRAY['o','b','t']::"char"[], false) AS has_out,
            p.pronargdefaults AS n_defaults,
            obj_description(p.oid, 'pg_proc') AS comment,
            (SELECT coalesce(json_agg(json_build_object(
                       'name', coalesce(p.proargnames[t.i], ''),
                       'type', format_type(t.typ, NULL),
                       'mode', coalesce(p.proargmodes[t.i]::text, 'i')) ORDER BY t.i), '[]'::json)
               FROM unnest(coalesce(p.proallargtypes, string_to_array(p.proargtypes::text, ' ')::oid[]))
                    WITH ORDINALITY AS t(typ, i)
              WHERE coalesce(p.proargmodes[t.i]::text, 'i') IN ('i','b','v')) AS args
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_type rt ON rt.oid = p.prorettype
      WHERE n.nspname = ANY(${S})
        AND p.prokind = 'f'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1, 2`,
  );

  // ---- assemble ----
  const pk = new Map<string, string[]>();
  const uniques = new Map<string, string[][]>();
  const foreignKeys: ForeignKey[] = [];
  for (const c of conRows) {
    const key = relKey(c.schema, c.table);
    if (c.type === "p") pk.set(key, c.cols);
    else if (c.type === "u") uniques.set(key, [...(uniques.get(key) ?? []), c.cols]);
    else if (c.type === "f" && c.fschema && c.ftable && c.fcols) {
      foreignKeys.push({
        name: c.name,
        schema: c.schema,
        table: c.table,
        cols: c.cols,
        fschema: c.fschema,
        ftable: c.ftable,
        fcols: c.fcols,
      });
    }
  }

  const colsByRel = new Map<string, Column[]>();
  for (const c of colRows) {
    const key = relKey(c.schema, c.table);
    const list = colsByRel.get(key) ?? [];
    list.push({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      hasDefault: c.has_default,
      defaultExpr: c.default_expr,
      generated: c.generated,
      comment: c.comment,
      position: c.pos,
    });
    colsByRel.set(key, list);
  }

  const relations = new Map<string, Relation>();
  for (const r of relRows) {
    const key = relKey(r.schema, r.name);
    relations.set(key, {
      schema: r.schema,
      name: r.name,
      kind: kindOf(r.kind),
      columns: colsByRel.get(key) ?? [],
      pk: pk.get(key) ?? [],
      uniques: uniques.get(key) ?? [],
      insertable: (r.bits & 8) === 8,
      updatable: (r.bits & 4) === 4,
      deletable: (r.bits & 16) === 16,
      comment: r.comment,
    });
  }

  const functions = new Map<string, FunctionDef[]>();
  for (const f of fnRows) {
    const nDefaults = f.n_defaults;
    const args: FunctionArg[] = f.args.map((a, i) => ({
      name: a.name,
      type: a.type,
      hasDefault: i >= f.args.length - nDefaults,
      variadic: a.mode === "v",
    }));
    const def: FunctionDef = {
      schema: f.schema,
      name: f.name,
      args,
      returnType: f.return_type,
      returnsSet: f.returns_set,
      returnsComposite: f.has_out || f.return_typtype === "c" || f.return_type === "record",
      returnsVoid: f.return_type === "void",
      volatility: f.volatility === "i" ? "immutable" : f.volatility === "s" ? "stable" : "volatile",
      comment: f.comment,
    };
    const key = relKey(f.schema, f.name);
    functions.set(key, [...(functions.get(key) ?? []), def]);
  }

  return { schemas, relations, foreignKeys, functions };
};

// ---------------------------------------------------------------------------
// Relationships (for resource embedding)
// ---------------------------------------------------------------------------

export type RelationshipKind = "m2o" | "o2m" | "o2o" | "m2m";

export interface Relationship {
  readonly kind: RelationshipKind;
  readonly from: Relation;
  readonly to: Relation;
  /** Join columns on `from` and `to` (direct relationships only). */
  readonly fromCols: ReadonlyArray<string>;
  readonly toCols: ReadonlyArray<string>;
  readonly fk: ForeignKey;
  /** Many-to-many only: the junction table and its two FKs. */
  readonly junction?: {
    readonly relation: Relation;
    /** junction → from */
    readonly fkFrom: ForeignKey;
    /** junction → to */
    readonly fkTo: ForeignKey;
  };
}

const sameCols = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((c) => b.includes(c));

const isUnique = (rel: Relation, cols: ReadonlyArray<string>) =>
  (rel.pk.length > 0 && sameCols(rel.pk, cols)) || rel.uniques.some((u) => sameCols(u, cols));

const describe = (r: Relationship): string => {
  const j = r.junction;
  if (j) {
    return `'${j.relation.name}' using '${j.fkFrom.name}' and '${j.fkTo.name}' (many-to-many)`;
  }
  return `'${r.fk.name}' (${r.kind === "m2o" ? "many-to-one" : r.kind === "o2o" ? "one-to-one" : "one-to-many"}) on ${r.fk.table}(${r.fk.cols.join(",")})`;
};

/** Find the relationships between `from` and the table/view named `target`. */
export const findRelationships = (
  cache: SchemaCache,
  from: Relation,
  target: string,
  hint?: string,
): Relationship[] => {
  const out: Relationship[] = [];
  const rel = (schema: string, name: string) => cache.relations.get(relKey(schema, name));

  for (const fk of cache.foreignKeys) {
    const selfReference = fk.schema === fk.fschema && fk.table === fk.ftable;
    // many-to-one: from → target (a self-reference is only reachable through its column name)
    if (fk.schema === from.schema && fk.table === from.name && fk.ftable === target && !selfReference) {
      const to = rel(fk.fschema, fk.ftable);
      if (to) out.push({ kind: "m2o", from, to, fromCols: fk.cols, toCols: fk.fcols, fk });
    }
    // many-to-one addressed by the foreign key column, e.g. `parent:parent_id(*)`
    if (fk.schema === from.schema && fk.table === from.name && fk.cols.length === 1 && fk.cols[0] === target) {
      const to = rel(fk.fschema, fk.ftable);
      if (to) out.push({ kind: "m2o", from, to, fromCols: fk.cols, toCols: fk.fcols, fk });
    }
    // one-to-many / one-to-one: target → from
    if (fk.fschema === from.schema && fk.ftable === from.name && fk.table === target) {
      const to = rel(fk.schema, fk.table);
      if (to) {
        out.push({
          kind: isUnique(to, fk.cols) ? "o2o" : "o2m",
          from,
          to,
          fromCols: fk.fcols,
          toCols: fk.cols,
          fk,
        });
      }
    }
  }

  // many-to-many through a junction table
  for (const fk1 of cache.foreignKeys) {
    if (fk1.fschema !== from.schema || fk1.ftable !== from.name) continue;
    const junction = rel(fk1.schema, fk1.table);
    if (!junction) continue;
    for (const fk2 of cache.foreignKeys) {
      if (fk2 === fk1) continue;
      if (fk2.schema !== fk1.schema || fk2.table !== fk1.table) continue;
      if (fk2.ftable !== target) continue;
      const to = rel(fk2.fschema, fk2.ftable);
      if (!to) continue;
      out.push({
        kind: "m2m",
        from,
        to,
        fromCols: fk1.fcols,
        toCols: fk2.fcols,
        fk: fk1,
        junction: { relation: junction, fkFrom: fk1, fkTo: fk2 },
      });
    }
  }

  if (!hint) return out;
  return out.filter((r) => {
    if (r.junction) {
      return r.junction.relation.name === hint || r.junction.fkFrom.name === hint || r.junction.fkTo.name === hint;
    }
    return r.fk.name === hint || r.fk.cols.includes(hint) || r.fk.fcols.includes(hint);
  });
};

/**
 * Resolve exactly one relationship or throw PostgREST-style PGRST200/PGRST201.
 * `target` may also be a table that is not related at all (→ PGRST200).
 */
export const resolveRelationship = (
  cache: SchemaCache,
  from: Relation,
  target: string,
  hint?: string,
): Relationship => {
  const found = findRelationships(cache, from, target, hint);
  if (found.length === 1) return found[0]!;
  if (found.length === 0) {
    throw new PgRestError(
      400,
      "PGRST200",
      `Could not find a relationship between '${from.name}' and '${target}' in the schema cache`,
      hint
        ? `Searched for a foreign key relationship between '${from.name}' and '${target}' using the hint '${hint}' in the schema '${from.schema}', but no matches were found.`
        : `Searched for a foreign key relationship between '${from.name}' and '${target}' in the schema '${from.schema}', but no matches were found.`,
      null,
    );
  }
  throw new PgRestError(
    300,
    "PGRST201",
    `Could not embed because more than one relationship was found for '${from.name}' and '${target}'`,
    JSON.stringify(found.map((r) => describe(r))),
    `Try changing '${target}' to one of the following: ${found
      .map((r) => `'${target}!${r.junction ? r.junction.relation.name : r.fk.name}'`)
      .join(", ")}. Find the desired relationship in the 'details' key.`,
  );
};

/** Look up a relation by (optional) schema and name, or throw PGRST205. */
export const getRelation = (cache: SchemaCache, schema: string, name: string): Relation => {
  const rel = cache.relations.get(relKey(schema, name));
  if (!rel) {
    throw new PgRestError(
      404,
      "PGRST205",
      `Could not find the table '${schema}.${name}' in the schema cache`,
      null,
      suggest(cache, schema, name),
    );
  }
  return rel;
};

const suggest = (cache: SchemaCache, schema: string, name: string): string | null => {
  let best: { name: string; d: number } | undefined;
  for (const r of cache.relations.values()) {
    if (r.schema !== schema) continue;
    const d = levenshtein(name.toLowerCase(), r.name.toLowerCase());
    if (d <= Math.max(1, Math.floor(name.length / 4)) && (!best || d < best.d)) {
      best = { name: r.name, d };
    }
  }
  return best ? `Perhaps you meant the table '${schema}.${best.name}'` : null;
};

const levenshtein = (a: string, b: string): number => {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
};
