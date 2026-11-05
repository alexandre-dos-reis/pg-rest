import type { Column, FunctionDef, Relation, SchemaCache } from "./schema";
import { findRelationships, relKey } from "./schema";

/**
 * Generate TypeScript types from an introspected schema, as the text of a module.
 *
 * The catalog is the only source: this is the same {@link SchemaCache} the request path reads, so
 * what the types allow is what the library accepts. Write the result next to your code and keep it
 * in version control:
 *
 * ```ts
 * writeFileSync("src/db.types.ts", generateTypes(await pgRest.schemaCache()));
 * ```
 */
export interface GenerateTypesOptions {
  /** Name of the exported type. Default `"Database"`. */
  readonly name?: string;
  /**
   * Nullability of view columns. The catalog reports every one of them as nullable, which is the
   * truth as far as it knows: a `NOT NULL` source column says nothing about a `LEFT JOIN` in the
   * view's own query. `"like-source"` follows `Column.source` instead -- shorter types, at the risk
   * of claiming non-null where an outer join can produce one.
   */
  readonly views?: "nullable" | "like-source";
  /** Banner comment. `false` leaves it out. */
  readonly header?: string | false;
}

const RESERVED_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** An object key: bare when it is a plain identifier, quoted otherwise. */
const key = (name: string): string => (RESERVED_KEY.test(name) ? name : JSON.stringify(name));

const pascal = (s: string): string =>
  s.replace(/(^|[^A-Za-z0-9])([A-Za-z0-9])/g, (_, __, c: string) => c.toUpperCase());

/**
 * Map a `format_type` string to a TypeScript type. Anything not recognised becomes `unknown`
 * rather than `string`: a type that is merely plausible is worse than one that forces a check.
 */
const scalar = (pgType: string): string => {
  const base = pgType.trim().replace(/\(.*\)$/, "");
  switch (base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base) {
    case "smallint":
    case "integer":
    case "bigint":
    case "numeric":
    case "decimal":
    case "real":
    case "double precision":
    case "smallserial":
    case "serial":
    case "bigserial":
      return "number";
    case "boolean":
      return "boolean";
    case "text":
    case "character varying":
    case "character":
    case "bpchar":
    case "varchar":
    case "char":
    case "name":
    case "citext":
    case "uuid":
    case "date":
    case "timestamp with time zone":
    case "timestamp without time zone":
    case "time with time zone":
    case "time without time zone":
    case "interval":
    case "bytea":
    case "money":
    case "xml":
    case "inet":
    case "cidr":
    case "macaddr":
    case "macaddr8":
    case "tsvector":
      return "string";
    default:
      return "unknown";
  }
};

/** The type of one column's value, enum labels and array dimensions included. */
export const columnType = (col: Pick<Column, "type" | "enumLabels">): string => {
  let t = col.type.trim();
  let dims = 0;
  while (t.endsWith("[]")) {
    t = t.slice(0, -2).trim();
    dims++;
  }
  const labels = col.enumLabels;
  const inner = labels?.length ? labels.map((l) => JSON.stringify(l)).join(" | ") : scalar(t);
  const wrapped = dims > 0 && inner.includes(" | ") ? `(${inner})` : inner;
  return wrapped + "[]".repeat(dims);
};

const nullableFor = (cache: SchemaCache, col: Column, views: "nullable" | "like-source"): boolean => {
  if (!col.nullable) return false;
  if (views === "nullable" || !col.source) return true;
  // the catalog says nullable because it is a view column; ask the column it is read from instead
  const source = cache.relations.get(relKey(col.source.schema, col.source.table));
  const base = source?.columns.find((c) => c.name === col.source!.column);
  return base ? base.nullable : true;
};

interface Lines {
  readonly push: (depth: number, text: string) => void;
}

const writer = (): { lines: string[]; push: Lines["push"] } => {
  const lines: string[] = [];
  return { lines, push: (depth, text) => lines.push(`${"  ".repeat(depth)}${text}`) };
};

/** `row`, `insert` and `update` of one relation. */
const shapes = (rel: Relation, sourceNullable: (col: Column) => boolean, push: Lines["push"], depth: number): void => {
  const cols = [...rel.columns].sort((a, b) => a.position - b.position);
  const value = (c: Column) => {
    const t = columnType(c);
    // `unknown | null` is just `unknown`: do not pretend the null is news
    return t === "unknown" || !sourceNullable(c) ? t : `${t} | null`;
  };

  push(depth, "row: {");
  for (const c of cols) push(depth + 1, `${key(c.name)}: ${value(c)};`);
  push(depth, "};");

  // A generated column cannot be written. A column with a default, or a nullable one, may be left out.
  const writable = cols.filter((c) => !c.generated);
  push(depth, rel.insertable ? "insert: {" : "insert: never;");
  if (rel.insertable) {
    for (const c of writable) {
      const optional = c.hasDefault || sourceNullable(c) ? "?" : "";
      push(depth + 1, `${key(c.name)}${optional}: ${value(c)};`);
    }
    push(depth, "};");
  }
  push(depth, rel.updatable ? "update: {" : "update: never;");
  if (rel.updatable) {
    for (const c of writable) push(depth + 1, `${key(c.name)}?: ${value(c)};`);
    push(depth, "};");
  }
};

/**
 * Every name that can be embedded from `rel`, resolved by the same {@link findRelationships} the
 * request path uses -- so a `select` the types accept is one the library can resolve.
 */
const embeds = (cache: SchemaCache, rel: Relation): Array<[string, string]> => {
  const candidates = new Set<string>();
  for (const r of cache.relations.values()) if (r.schema === rel.schema && r.name !== rel.name) candidates.add(r.name);
  // `parent:parent_id(*)`: a single-column foreign key is addressable by its column
  for (const fk of cache.foreignKeys) {
    if (fk.schema === rel.schema && fk.table === rel.name && fk.cols.length === 1) candidates.add(fk.cols[0]!);
  }
  // computed relationships live in the functions map, keyed like a relation
  for (const [k, defs] of cache.functions) {
    const [schema, ...rest] = k.split(".");
    if (schema !== rel.schema) continue;
    if (defs.some((d) => d.argRelation?.schema === rel.schema && d.argRelation.name === rel.name && d.returnRelation)) {
      candidates.add(rest.join("."));
    }
  }

  const out: Array<[string, string]> = [];
  for (const target of [...candidates].sort()) {
    const found = findRelationships(cache, rel, target);
    const usable = found.filter((r) => r.to.schema === rel.schema);
    if (usable.length === 0) continue;
    const first = usable[0]!;
    const to = first.kind === "o2m" || first.kind === "m2m" ? "many" : "one";
    const hints = usable.map((r) => JSON.stringify(r.fk.name)).join(", ");
    // more than one relationship means the request has to carry a hint (PGRST201)
    const ambiguous = usable.length > 1 ? `; ambiguous: true; hints: [${hints}]` : "";
    out.push([target, `{ rel: ${JSON.stringify(first.to.name)}; to: ${JSON.stringify(to)}${ambiguous} }`]);
  }
  return out;
};

/** The arguments and result of one overload. */
const signature = (fn: FunctionDef, relationsType: string, cache: SchemaCache): string => {
  // A single unnamed parameter takes the request body as it is, so there is no object to describe.
  const raw = fn.args.length === 1 && fn.args[0]!.name === "";
  const args = raw
    ? columnType({ type: fn.args[0]!.type, enumLabels: fn.args[0]!.enumLabels })
    : fn.args.length === 0
      ? "{}"
      : `{ ${fn.args
          .map((a) => {
            const t = columnType({ type: a.type, enumLabels: a.enumLabels });
            return `${key(a.name)}${a.hasDefault ? "?" : ""}: ${t}`;
          })
          .join("; ")} }`;
  const target = fn.returnRelation
    ? cache.relations.get(relKey(fn.returnRelation.schema, fn.returnRelation.name))
    : undefined;
  const returns = fn.returnsVoid
    ? "null"
    : target
      ? `${relationsType}[${JSON.stringify(target.name)}]["row"]`
      : // a TABLE(...) / record function: the catalog does not carry its output columns, and
        // neither does the request path (it builds a relation with no columns)
        fn.returnsComposite
        ? "Record<string, unknown>"
        : columnType({ type: fn.returnType, enumLabels: fn.returnEnumLabels });
  return `{ args: ${args}; returns: ${returns}; set: ${fn.returnsSet}${raw ? "; raw: true" : ""} }`;
};

/** Generate the module text. Deterministic: same catalog, same bytes. */
export const generateTypes = (cache: SchemaCache, options: GenerateTypesOptions = {}): string => {
  const name = options.name ?? "Database";
  const views = options.views ?? "nullable";
  const { lines, push } = writer();

  if (options.header !== false) {
    push(0, `// ${options.header ?? `Generated from the database catalog by @adrdp/pg-rest. Do not edit.`}`);
    push(0, "");
  }

  const schemas = [...cache.schemas];
  for (const schema of schemas) {
    const relationsType = `${name}${pascal(schema)}Relations`;
    const relations = [...cache.relations.values()]
      .filter((r) => r.schema === schema)
      .sort((a, b) => a.name.localeCompare(b.name));

    push(0, `type ${relationsType} = {`);
    for (const rel of relations) {
      const sourceNullable = (c: Column) => nullableFor(cache, c, views);
      push(1, `${key(rel.name)}: {`);
      shapes(rel, sourceNullable, push, 2);
      push(2, `pk: [${rel.pk.map((c) => JSON.stringify(c)).join(", ")}];`);
      push(2, `insertable: ${rel.insertable};`);
      push(2, `updatable: ${rel.updatable};`);
      push(2, `deletable: ${rel.deletable};`);
      const rels = embeds(cache, rel);
      if (rels.length === 0) {
        push(2, "rel: {};");
      } else {
        push(2, "rel: {");
        for (const [target, entry] of rels) push(3, `${key(target)}: ${entry};`);
        push(2, "};");
      }
      push(1, "};");
    }
    push(0, "};");
    push(0, "");

    const functionsType = `${name}${pascal(schema)}Functions`;
    const fns = [...cache.functions.entries()]
      .filter(([k]) => k.startsWith(`${schema}.`))
      .map(
        ([k, defs]) => [k.slice(schema.length + 1), defs.filter((d) => !(d.argRelation && d.returnRelation))] as const,
      )
      .filter(([, defs]) => defs.length > 0)
      .sort(([a], [b]) => a.localeCompare(b));

    if (fns.length === 0) {
      push(0, `type ${functionsType} = {};`);
    } else {
      push(0, `type ${functionsType} = {`);
      for (const [fnName, defs] of fns) {
        const overloads = defs.map((d) => signature(d, relationsType, cache)).join(", ");
        push(1, `${key(fnName)}: [${overloads}];`);
      }
      push(0, "};");
    }
    push(0, "");
  }

  push(0, `export type ${name} = {`);
  push(1, `default: ${JSON.stringify(schemas[0] ?? "public")};`);
  push(1, "schemas: {");
  for (const schema of schemas) {
    push(
      2,
      `${key(schema)}: { relations: ${name}${pascal(schema)}Relations; functions: ${name}${pascal(schema)}Functions };`,
    );
  }
  push(1, "};");
  push(0, "};");
  return `${lines.join("\n")}\n`;
};
