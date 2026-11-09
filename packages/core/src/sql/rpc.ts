import { ALIAS } from "../constants";
import { EngineError } from "../errors";
import { quoteIdent, quoteQualified } from "../quote";
import { type FunctionDef, type Relation, type SchemaCache, levenshtein, relKey } from "../schema";

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

/** What a body is read as: JSON, or a raw body (`text/plain`, `text/xml`, `application/octet-stream`). */
export type BodyType = "json" | "text" | "xml" | "bytea";

const BODY_TYPES: Record<BodyType, ReadonlySet<string>> = {
  json: new Set(["json", "jsonb"]),
  text: new Set(["text"]),
  xml: new Set(["xml"]),
  bytea: new Set(["bytea"]),
};

/** A function that takes the whole body as its only, unnamed parameter. */
export const isSingleUnnamedParam = (fn: FunctionDef, as: BodyType = "json"): boolean =>
  fn.args.length === 1 && fn.args[0]!.name === "" && BODY_TYPES[as].has(fn.args[0]!.type);

/** PostgREST's spelling used when more than one function fits: `schema.fn(a => integer, b => text)`. */
const arrowSignature = (fn: FunctionDef): string =>
  `${fn.schema}.${fn.name}(${fn.args.map((a) => `${a.name} => ${a.type}`).join(", ")})`;

/** Similarity of two names, 1 for equal; PostgREST suggests the closest name above ~0.75. */
const similarity = (a: string, b: string): number =>
  1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / Math.max(a.length, b.length, 1);
const SUGGEST_AT = 0.75;

/** The "Perhaps you meant ..." hint of `function_not_found`. */
const functionHint = (
  cache: SchemaCache,
  schema: string,
  name: string,
  candidates: ReadonlyArray<FunctionDef>,
  provided: ReadonlySet<string>,
): string | null => {
  if (candidates.length > 0) {
    // nothing was given and a function takes one unnamed parameter: PostgREST suggests its (empty) list of names
    if (
      provided.size === 0 &&
      candidates.some((fn) => (Object.keys(BODY_TYPES) as BodyType[]).some((t) => isSingleUnnamedParam(fn, t)))
    ) {
      return `Perhaps you meant to call the function ${schema}.${name}()`;
    }
    // same name, different parameters: suggest the signature sharing the most parameter names
    let best: { fn: FunctionDef; score: number } | undefined;
    for (const fn of candidates) {
      let score = 0;
      for (const p of provided) {
        if (fn.args.some((a) => a.name === p)) score += 2;
        else if (fn.args.some((a) => similarity(a.name, p) >= SUGGEST_AT)) score += 1;
      }
      if (score > 0 && (!best || score > best.score)) best = { fn, score };
    }
    return best
      ? `Perhaps you meant to call the function ${schema}.${name}(${best.fn.args
          .map((a) => a.name)
          .sort()
          .join(", ")})`
      : null;
  }
  // no such function: suggest a similarly named one
  let best: { name: string; score: number } | undefined;
  for (const fns of cache.functions.values()) {
    const fn = fns[0];
    if (!fn || fn.schema !== schema) continue;
    const score = similarity(name, fn.name);
    if (score >= SUGGEST_AT && (!best || score > best.score)) best = { name: fn.name, score };
  }
  return best ? `Perhaps you meant to call the function ${schema}.${best.name}` : null;
};

/**
 * Pick the function to call from the argument names the client supplied.
 * `rawBody` is true when a body that is not a JSON object was given;
 * `post` tells whether the function was invoked with POST (which also allows a single unnamed parameter).
 */
export const resolveFunction = (
  cache: SchemaCache,
  schema: string,
  name: string,
  provided: ReadonlySet<string>,
  hasBody: boolean,
  post = true,
  bodyType: BodyType = "json",
): FunctionDef => {
  const candidates = cache.functions.get(relKey(schema, name)) ?? [];
  const names = [...provided].sort();
  const params =
    names.length === 0 ? "without parameters" : `with parameter${names.length === 1 ? "" : "s"} ${names.join(", ")}`;
  const notFound = () =>
    new EngineError(
      "function_not_found",
      names.length === 0
        ? `Could not find the function ${schema}.${name} without parameters in the schema cache`
        : `Could not find the function ${schema}.${name}(${names.join(", ")}) in the schema cache`,
      `Searched for the function ${schema}.${name} ${params}${post ? " or with a single unnamed json/jsonb parameter" : ""}, but no matches were found in the schema cache.`,
      functionHint(cache, schema, name, candidates, provided),
    );

  if (bodyType !== "json") {
    // a raw body goes to a function that takes nothing else
    const raw = candidates.filter((fn) => isSingleUnnamedParam(fn, bodyType));
    if (raw.length === 1) return raw[0]!;
    throw new EngineError(
      "function_not_found",
      `Could not find the function ${schema}.${name} in the schema cache`,
      `Searched for the function ${schema}.${name} with a single unnamed ${bodyType} parameter, but no matches were found in the schema cache.`,
      null,
    );
  }
  if (candidates.length === 0) throw notFound();

  const named = candidates.filter((fn) => {
    const argNames = new Set(fn.args.map((a) => a.name));
    for (const p of provided) if (!argNames.has(p)) return false;
    return fn.args.every((a) => a.hasDefault || provided.has(a.name));
  });
  const single = hasBody ? candidates.filter((fn) => isSingleUnnamedParam(fn)) : [];

  const matches =
    provided.size === 0 && hasBody && single.length > 0
      ? single
      : [...named, ...single.filter((s) => !named.includes(s))];
  if (matches.length === 0) throw notFound();
  if (matches.length === 1) return matches[0]!;

  const exact = matches.filter((fn) => fn.args.length === provided.size);
  if (exact.length === 1) return exact[0]!;
  throw new EngineError(
    "ambiguous_function",
    `Could not choose the best candidate function between: ${matches.map(arrowSignature).sort().join(", ")}`,
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
  bodyType: BodyType = "json",
): RpcCall => {
  const fnRef = quoteQualified(fn.schema, fn.name);
  let args: string;
  let usesBody = false;
  let from = "";

  if (rawBody && isSingleUnnamedParam(fn, bodyType)) {
    const t = fn.args[0]!.type;
    // a binary body travels as hex: a text parameter would read its backslashes
    args = bodyType === "bytea" ? `decode($1::text, 'hex')` : `($1::text)::${t}`;
    usesBody = true;
  } else {
    const used = fn.args.filter((a) => provided.includes(a.name));
    args = used
      .map((a) => `${a.variadic ? "VARIADIC " : ""}${quoteIdent(a.name)} := _args.${quoteIdent(a.name)}`)
      .join(", ");
    if (used.length > 0) {
      usesBody = true;
      from = `json_to_record(($1::text)::json) AS _args(${used.map((a) => `${quoteIdent(a.name)} ${a.type}`).join(", ")}) CROSS JOIN LATERAL `;
    }
  }

  const call = `${from}${fnRef}(${args}) AS _f`;
  const base = fn.returnsVoid
    ? `SELECT 1 AS ${ALIAS}_scalar FROM ${call}`
    : fn.returnsComposite
      ? `SELECT _f.* FROM ${call}`
      : `SELECT _f AS ${ALIAS}_scalar FROM ${call}`;

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
