import { PgRestError } from "../errors";
import { quoteIdent, quoteQualified } from "../quote";
import { type FunctionDef, type Relation, type SchemaCache, relKey } from "../schema";

export type RpcShape =
  /** Rows of a table-like result: SETOF composite / TABLE(...). */
  | "rows"
  /** A single composite row. */
  | "object"
  /** SETOF scalar. */
  | "scalar-set"
  /** A single scalar value. */
  | "scalar"
  | "void";

export interface RpcCall {
  readonly fn: FunctionDef;
  readonly shape: RpcShape;
  /** A SELECT that yields the function result as a relation. Uses `$1` for arguments when `hasBody`. */
  readonly source: string;
  /** True when the SQL references `$1` (a JSON text with the arguments). */
  readonly usesBody: boolean;
  /** Table the result rows belong to, when known (enables embedding) — or a synthetic one. */
  readonly relation: Relation;
}

const SINGLE_BODY_TYPES = new Set(["json", "jsonb", "text", "bytea"]);

const isSingleUnnamedParam = (fn: FunctionDef): boolean =>
  fn.args.length === 1 && fn.args[0]!.name === "" && SINGLE_BODY_TYPES.has(fn.args[0]!.type);

const signature = (fn: FunctionDef): string =>
  `${fn.schema}.${fn.name}(${fn.args.map((a) => `${a.name} ${a.type}`).join(", ")})`;

/**
 * Pick the function to call from the argument names the client supplied.
 * `rawBody` is true when a request body that is not a JSON object was given.
 */
export const resolveFunction = (
  cache: SchemaCache,
  schema: string,
  name: string,
  provided: ReadonlySet<string>,
  hasBody: boolean,
): FunctionDef => {
  const candidates = cache.functions.get(relKey(schema, name)) ?? [];
  const sig = `${schema}.${name}(${[...provided].sort().join(", ")})`;
  const notFound = () =>
    new PgRestError(
      404,
      "PGRST202",
      `Could not find the function ${sig} in the schema cache`,
      candidates.length
        ? `Searched for the function ${schema}.${name} with parameter${provided.size === 1 ? "" : "s"} ${[...provided].sort().join(", ") || "(none)"}, but no matches were found in the schema cache.`
        : null,
      candidates.length
        ? `Perhaps you meant to call the function ${signature(candidates[0]!)}`
        : "If a new function was created in the database with this name and parameters, try reloading the schema cache.",
    );

  if (candidates.length === 0) throw notFound();

  const named = candidates.filter((fn) => {
    const names = new Set(fn.args.map((a) => a.name));
    for (const p of provided) if (!names.has(p)) return false;
    return fn.args.every((a) => a.hasDefault || provided.has(a.name));
  });
  const single = hasBody ? candidates.filter(isSingleUnnamedParam) : [];

  const matches = provided.size === 0 && hasBody && single.length > 0 ? single : [...named, ...single.filter((s) => !named.includes(s))];
  if (matches.length === 0) throw notFound();
  if (matches.length === 1) return matches[0]!;

  const exact = matches.filter((fn) => fn.args.length === provided.size);
  if (exact.length === 1) return exact[0]!;
  throw new PgRestError(
    300,
    "PGRST203",
    `Could not choose the best candidate function between: ${matches.map(signature).join(", ")}`,
    null,
    "Try renaming the parameters or the function itself in the database so function overloading can be resolved",
  );
};

const stripQuotes = (s: string) => s.replace(/^"|"$/g, "");

/** Find the table a composite return type refers to, if it is an exposed relation. */
const relationOfReturnType = (cache: SchemaCache, fn: FunctionDef): Relation | undefined => {
  if (!fn.returnsComposite) return undefined;
  const t = fn.returnType.replace(/\[\]$/, "");
  const dot = t.indexOf(".");
  if (dot > 0) return cache.relations.get(relKey(stripQuotes(t.slice(0, dot)), stripQuotes(t.slice(dot + 1))));
  const bare = stripQuotes(t);
  const inOwn = cache.relations.get(relKey(fn.schema, bare));
  if (inOwn) return inOwn;
  for (const r of cache.relations.values()) if (r.name === bare) return r;
  return undefined;
};

const syntheticRelation = (fn: FunctionDef): Relation => ({
  schema: fn.schema,
  name: fn.name,
  kind: "view",
  columns: [],
  pk: [],
  uniques: [],
  insertable: false,
  updatable: false,
  deletable: false,
  comment: null,
});

/**
 * Build the SQL that calls `fn`. Arguments travel as one JSON text (`$1`) and
 * are converted by `json_to_record` using the declared types, so values are
 * never interpolated into SQL.
 */
export const buildRpc = (
  cache: SchemaCache,
  fn: FunctionDef,
  provided: ReadonlyArray<string>,
  rawBody: boolean,
): RpcCall => {
  const fnRef = quoteQualified(fn.schema, fn.name);
  let args: string;
  let usesBody = false;
  let from = "";

  if (rawBody && isSingleUnnamedParam(fn)) {
    const t = fn.args[0]!.type;
    args = `($1::text)::${t}`;
    usesBody = true;
  } else {
    const used = fn.args.filter((a) => provided.includes(a.name));
    args = used.map((a) => `${quoteIdent(a.name)} := _args.${quoteIdent(a.name)}`).join(", ");
    if (used.length > 0) {
      usesBody = true;
      from = `json_to_record(($1::text)::json) AS _args(${used.map((a) => `${quoteIdent(a.name)} ${a.type}`).join(", ")}) CROSS JOIN LATERAL `;
    }
  }

  const call = `${from}${fnRef}(${args}) AS _f`;
  const base = fn.returnsVoid
    ? `SELECT 1 AS pgrst_scalar FROM ${call}`
    : fn.returnsComposite
      ? `SELECT _f.* FROM ${call}`
      : `SELECT _f AS pgrst_scalar FROM ${call}`;

  const shape: RpcShape = fn.returnsVoid
    ? "void"
    : fn.returnsComposite
      ? fn.returnsSet
        ? "rows"
        : "object"
      : fn.returnsSet
        ? "scalar-set"
        : "scalar";

  const relation = relationOfReturnType(cache, fn) ?? syntheticRelation(fn);
  return { fn, shape, source: base, usesBody, relation };
};
