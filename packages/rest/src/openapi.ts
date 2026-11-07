import type { Column, FunctionDef, Relation, SchemaCache } from "@tsql/core/schema";

type Json = Record<string, unknown>;

/** The media types the document advertises. RPC paths cannot answer CSV, so they list the first three. */
const MEDIA_TYPES = [
  "application/json",
  "application/vnd.pgrst.object+json;nulls=stripped",
  "application/vnd.pgrst.object+json",
  "text/csv",
] as const;
const RPC_MEDIA_TYPES = MEDIA_TYPES.slice(0, 3);

/** A `Prefer` header parameter, with the preferences it accepts. */
const preferParam = (values: ReadonlyArray<string>): Json => ({
  name: "Prefer",
  description: "Preference",
  required: false,
  in: "header",
  type: "string",
  enum: values,
});

/** Map a Postgres `format_type` string to an OpenAPI 2.0 schema fragment. */
export const pgTypeToOpenApi = (pgType: string): Json => {
  const t = pgType.trim();
  if (t.endsWith("[]")) {
    return { type: "array", items: pgTypeToOpenApi(t.slice(0, -2)) };
  }
  const base = t.replace(/\(.*\)$/, "");
  switch (base) {
    case "smallint":
    case "integer":
      return { type: "integer", format: base };
    case "bigint":
      return { type: "integer", format: "bigint" };
    case "numeric":
    case "decimal":
      return { type: "number", format: "numeric" };
    case "real":
      return { type: "number", format: "real" };
    case "double precision":
      return { type: "number", format: "double precision" };
    case "boolean":
      return { type: "boolean", format: "boolean" };
    case "json":
    case "jsonb":
      return { format: base };
    case "uuid":
    case "text":
    case "date":
    case "bytea":
    case "money":
    case "interval":
      return { type: "string", format: base };
    case "character varying":
    case "character":
      return { type: "string", format: t };
    case "timestamp with time zone":
    case "timestamp without time zone":
    case "time with time zone":
    case "time without time zone":
      return { type: "string", format: base };
    default:
      return { type: "string", format: t };
  }
};

const columnSchema = (rel: Relation, c: Column): Json => {
  const s: Json = pgTypeToOpenApi(c.type);
  const notes: string[] = [];
  if (c.comment) notes.push(c.comment);
  if (rel.pk.includes(c.name)) notes.push("Note:\nThis is a Primary Key.<pk/>");
  if (notes.length) s["description"] = notes.join("\n\n");
  if (c.hasDefault && c.defaultExpr && !c.defaultExpr.includes("nextval(")) s["default"] = c.defaultExpr;
  return s;
};

const FILTER_NOTE = "Filter using PostgREST operators, e.g. `eq.1`, `gt.5`, `in.(a,b)`, `is.null`";

export interface OpenApiOptions {
  readonly serverUrl: string;
  readonly basePath: string;
}

/** Build the Swagger 2.0 document PostgREST serves at `/`. */
export const buildOpenApi = (cache: SchemaCache, schema: string, opts: OpenApiOptions): Json => {
  let host = "localhost";
  let scheme = "http";
  try {
    const u = new URL(opts.serverUrl);
    host = u.host;
    scheme = u.protocol.replace(":", "");
  } catch {
    /* keep defaults */
  }

  const relations = [...cache.relations.values()]
    .filter((r) => r.schema === schema)
    .sort((a, b) => a.name.localeCompare(b.name));
  const functions = [...cache.functions.values()]
    .flat()
    .filter((f) => f.schema === schema)
    .sort((a, b) => a.name.localeCompare(b.name));

  const parameters: Json = {
    preferReturn: preferParam(["return=representation", "return=minimal", "return=headers-only"]),
    preferCount: preferParam(["count=none"]),
    preferPost: preferParam([
      "return=representation",
      "return=minimal",
      "return=headers-only",
      "resolution=ignore-duplicates",
      "resolution=merge-duplicates",
    ]),
    select: { name: "select", description: "Filtering Columns", required: false, in: "query", type: "string" },
    on_conflict: { name: "on_conflict", description: "On Conflict", required: false, in: "query", type: "string" },
    order: { name: "order", description: "Ordering", required: false, in: "query", type: "string" },
    range: { name: "Range", description: "Limiting and Pagination", required: false, in: "header", type: "string" },
    rangeUnit: {
      name: "Range-Unit",
      description: "Limiting and Pagination",
      required: false,
      default: "items",
      in: "header",
      type: "string",
    },
    offset: { name: "offset", description: "Limiting and Pagination", required: false, in: "query", type: "string" },
    limit: { name: "limit", description: "Limiting and Pagination", required: false, in: "query", type: "string" },
  };
  const paths: Json = {
    "/": {
      get: {
        tags: ["Introspection"],
        summary: "OpenAPI description (this document)",
        produces: ["application/openapi+json", "application/json"],
        responses: { "200": { description: "OK" } },
      },
    },
  };
  const definitions: Json = {};

  for (const rel of relations) {
    const props: Json = {};
    const required: string[] = [];
    for (const c of rel.columns) {
      props[c.name] = columnSchema(rel, c);
      if (!c.nullable && !c.hasDefault) required.push(c.name);
    }
    definitions[rel.name] = {
      type: "object",
      ...(required.length ? { required } : {}),
      properties: props,
      ...(rel.comment ? { description: rel.comment } : {}),
    };

    const filterRefs: Json[] = [];
    for (const c of rel.columns) {
      const key = `rowFilter.${rel.name}.${c.name}`;
      parameters[key] = { name: c.name, required: false, in: "query", type: "string", description: FILTER_NOTE };
      filterRefs.push({ $ref: `#/parameters/${key}` });
    }
    const bodyKey = `body.${rel.name}`;
    parameters[bodyKey] = {
      name: rel.name,
      description: rel.name,
      required: false,
      in: "body",
      schema: { $ref: `#/definitions/${rel.name}` },
    };

    const ref = `#/definitions/${rel.name}`;
    const op: Json = {
      get: {
        tags: [rel.name],
        parameters: [
          ...filterRefs,
          { $ref: "#/parameters/select" },
          { $ref: "#/parameters/order" },
          { $ref: "#/parameters/range" },
          { $ref: "#/parameters/rangeUnit" },
          { $ref: "#/parameters/offset" },
          { $ref: "#/parameters/limit" },
          { $ref: "#/parameters/preferCount" },
        ],
        responses: {
          "200": { description: "OK", schema: { type: "array", items: { $ref: ref } } },
          "206": { description: "Partial Content" },
        },
        ...(rel.comment ? { summary: rel.comment } : {}),
      },
    };
    if (rel.insertable) {
      op["post"] = {
        tags: [rel.name],
        parameters: [
          { $ref: `#/parameters/${bodyKey}` },
          { $ref: "#/parameters/select" },
          { $ref: "#/parameters/preferPost" },
        ],
        responses: { "201": { description: "Created" } },
      };
    }
    if (rel.deletable) {
      op["delete"] = {
        tags: [rel.name],
        parameters: [...filterRefs, { $ref: "#/parameters/preferReturn" }],
        responses: { "204": { description: "No Content" } },
      };
    }
    if (rel.updatable) {
      op["patch"] = {
        tags: [rel.name],
        parameters: [...filterRefs, { $ref: `#/parameters/${bodyKey}` }, { $ref: "#/parameters/preferReturn" }],
        responses: { "204": { description: "No Content" } },
      };
    }
    paths[`/${rel.name}`] = op;
  }

  const seen = new Set<string>();
  for (const fn of functions) {
    if (seen.has(fn.name)) continue; // overloads share a path; the first signature is documented
    seen.add(fn.name);
    paths[`/rpc/${fn.name}`] = rpcPath(fn);
  }

  return {
    swagger: "2.0",
    info: {
      title: `standard ${schema} schema`,
      description: "",
      version: "16",
    },
    host,
    basePath: opts.basePath || "/",
    schemes: [scheme],
    consumes: MEDIA_TYPES,
    produces: MEDIA_TYPES,
    paths,
    definitions,
    parameters,
    externalDocs: { description: "PostgREST Documentation", url: "https://postgrest.org/en/v16/references/api.html" },
  };
};

const rpcPath = (fn: FunctionDef): Json => {
  const props: Json = {};
  const required: string[] = [];
  for (const a of fn.args) {
    if (!a.name) continue;
    props[a.name] = pgTypeToOpenApi(a.type);
    if (!a.hasDefault) required.push(a.name);
  }
  const post: Json = {
    tags: [`(rpc) ${fn.name}`],
    produces: RPC_MEDIA_TYPES,
    parameters: [
      {
        name: "args",
        required: true,
        in: "body",
        schema: { type: "object", properties: props, ...(required.length ? { required } : {}) },
      },
    ],
    responses: { "200": { description: "OK" } },
    ...(fn.comment ? { summary: fn.comment } : {}),
  };
  const path: Json = { post };
  // Volatile functions cannot be called with GET (PostgREST v16).
  if (fn.volatility !== "volatile") {
    path["get"] = {
      tags: [`(rpc) ${fn.name}`],
      produces: RPC_MEDIA_TYPES,
      parameters: fn.args
        .filter((a) => a.name)
        .map((a) => ({ name: a.name, required: !a.hasDefault, in: "query", ...pgTypeToOpenApi(a.type) })),
      responses: { "200": { description: "OK" } },
    };
  }
  return path;
};
