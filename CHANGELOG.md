# pg-rest

## 0.2.0

### Minor Changes

- 5e684f0: `pgRest.generateTypes(options?)` writes the TypeScript types without a second import or a trip through the schema cache:

  ```ts
  writeFileSync("src/db.types.ts", await pgRest.generateTypes({ name: "Database" }));
  ```

  The generator is a build-time job, so it is loaded by that call and not before: `dist/index.js` does not carry it, and a
  server that only serves requests pays nothing for it (2.9 KB gzipped, measured). `generateTypes(cache, options?)` is
  still exported from `@adrdp/pg-rest/types` for when you hold a `SchemaCache` rather than an instance — both routes are
  the same function and produce identical output, which a test asserts.

- dd386e5: Add `generateTypes(cache)`, published as `@adrdp/pg-rest/types`: TypeScript types for your database, generated from
  `schemaCache()` — the introspected catalog the request path itself reads, so what the types allow is what the library
  accepts.

  ```ts
  import { writeFileSync } from "node:fs";
  import { generateTypes } from "@adrdp/pg-rest/types";

  writeFileSync("src/db.types.ts", generateTypes(await pgRest.schemaCache(), { name: "DatabasePgRest" }));
  ```

  It emits `row` / `insert` / `update` per relation (generated columns left out of writes, optional where there is a
  default or a nullable column, `never` where the relation cannot be written), the primary key and the privileges, every
  embeddable name with `to: "one" | "many"` — resolved by `findRelationships`, the same function the request path uses —
  and the functions with their arguments, optionality, overloads and result type. The output is a plain module with no
  imports: commit it, and add it to your formatter's ignore list.

  Unrecognised types become `unknown` rather than a plausible `string`. A view column is typed `| null` because that is
  what the catalog says of every view column; `views: "like-source"` follows the source column instead. A column the
  database refuses to be given a value -- generated, or `GENERATED ALWAYS AS IDENTITY` -- is left out of `insert` and
  `update` entirely, so `rows: { id: 42, … }` is a compile error instead of a `428C9` from Postgres.

  Two additions to the introspection, which the generator needed and which are useful on their own:

  - `Column.enumLabels` / `FunctionArg.enumLabels` / `FunctionDef.returnEnumLabels`: the labels of an enum type, in
    declaration order, for a column, argument or result that is an enum or an array of one. Enums become a union of string
    literals in the generated types.
  - `Column.source`: for a view column read straight from a table column, that column, followed through view-over-view
    chains. `nullable` is unchanged (the catalog reports every view column as nullable, and a `NOT NULL` source says
    nothing about a `LEFT JOIN` in the view's own query).
  - `Column.identity`: `"always"` or `"by-default"`, which `hasDefault` alone could not tell apart.

- 27a06dc: Add `query(input, ctx?)`: run a query from a plain JavaScript object, in-process, with no `Request`, no URL and no HTTP
  status — something a PostgREST server cannot offer, and the reason this is a library.

  ```ts
  const { data } = await pgRest.query({
    table: "todos",
    select: ["id", "title", { tags: ["label"] }],
    where: { done: false, or: [{ priority: ["gte", 3] }, { pinned: true }] },
    order: [{ column: "created", desc: true }],
    limit: 10,
  });
  ```

  It is the same pipeline as `handle()`, not a second implementation: the object becomes the query parameters PostgREST would
  have parsed, so the `select` trees, every filter operator, embedding, the `set_config` of role and claims (RLS applies),
  the SQL builders and the SQLSTATE mapping are all shared. Reads, writes (`insert`, `upsert`, `update`, `delete`) and `rpc`
  are covered; content negotiation (CSV, GeoJSON, media type handlers), `EXPLAIN` plans, `Range`, `OPTIONS` and OpenAPI stay
  on `handle()`. Failures throw a `QueryError` — an `Error` carrying the PostgREST status and body (`code`, `message`,
  `details`, `hint`) plus the input that produced it.

  `querySafe(input, ctx?)` is the same query with the failure as a value rather than an exception, for call sites where
  that reads better:

  ```ts
  const { data, error } = await pgRest.querySafe({ table: "cients" });
  if (error) return c.json(error.body, error.status);
  ```

  Exactly one of `data` and `error` is set, so narrowing on `error` leaves `data` non-null. It is the same `QueryError`
  `query()` throws, and `querySafe()` **never rejects** — an unforeseen error comes back as a 500 `error` carrying the
  original under `cause`. `query()` itself is unchanged.

  Two deliberate defaults differ from HTTP, both reversible: a write returns its rows unless `returning: "minimal"`, and a
  function call is always a `POST`.

  Also:

  - `ApiError.message` now summarises the error for logs and stack traces (`"PGRST205: … hint: …"`). The response body is
    unchanged, so HTTP clients see exactly what they saw before.
  - `PreRequestInfo.request` is now optional: an in-process `query()` call has no `Request`. A `preRequest` callback that
    reads it needs a `?.` (or `info.request && …`). SQL `preRequest` functions and everything else are unaffected.

- b77dcf9: `createPgRest<Db>(options)` types the queries from a generated database type: `table` and `rpc` are the ones that exist,
  `select`, `where` and `order` only name real columns and relationships, and `data` is inferred from the `select`.

  ```ts
  const pgRest = await createPgRest<DatabasePgRest>({ db: nodePostgresAdapter(pool), schemas: ["api"] });

  const { data } = await pgRest.query({
    table: "todos",
    select: ["id", "title", { tags: ["label"] }],
    where: { done: false },
    limit: 10,
  });
  // data: Array<{ id: number; title: string; tags: Array<{ label: string }> }>
  ```

  The inference follows what the runtime actually answers: a to-one embed is an object or `null` (not null with
  `inner: true`), a to-many embed is an array, `as` renames the key, `spread` merges the columns into the parent row and
  turns each one into an array when it spreads a to-many, `single: true` returns the object alone, `returning: "minimal"`
  returns `null`, and a function's arguments and result come from its signature, overloads and set-returning included.
  Enums are unions of their labels, so a filter only takes a real label. A field that no query accepts — a misspelled
  `limitt` the runtime would drop in silence — is refused.

  The table restricts the columns in the editor as well as in the compiler: inside `select` on `tags`, the completion
  offers that table's columns and nothing from the others. TypeScript narrows the contextual type of a nested property only
  when the discriminant picks exactly one member of the union, so the query type keeps one member per table -- reads and
  writes merged, each action's payload required and the others refused by `WriteRules` -- and every member declares
  `table`, function calls included (`table?: never`). Naming both `table` and `rpc` is now a type error rather than a
  runtime one.

  The type argument goes on `createPgRest`, not on the call: TypeScript stops inferring the remaining type arguments as
  soon as one is given explicitly, so `query<Db>({ … })` could check the input but would then return `unknown`.

  `as` and `spread` on an embed are exclusive, because PostgREST's grammar has no way to write both (`...alias:table(*)`
  is a `PGRST100`), so a type that accepted it would promise something the request cannot express.

  Casts (`total::text`), JSON paths (`meta->>tier`) and aggregates (`total.sum()`) are not described by the typed input:
  they change or invent a column, and reading that back out of a string literal would cost more than it gives.
  `createPgRest(options)` without a type argument is unchanged — the loose input and `query<Todo[]>(…)` still work — and
  `handle` is untouched in both cases.

## 0.1.3

### Patch Changes

- d870849: fix package name ref is docs and examples

## 0.1.2

### Patch Changes

- 4de8a7d: confirm github and npm trust

## 0.1.1

### Patch Changes

- confirm trust between github and npm

## 0.1.0

### Minor Changes

- 5b2f874: First release. A PostgREST-compatible REST layer for PostgreSQL, used as a library: you hand
  `createPgRest` a `DbAdapter` over your own driver (Bun.sql, node-postgres, postgres.js, PGlite) and
  mount `handle(Request) => Response` in any web-standard server. There is no JWT layer — `resolveContext`
  decides who is calling, and Row Level Security does the rest.

  Request/response behaviour is compared against the real PostgREST 16 binary on the same database: of
  339 cases, 338 match byte-for-byte and one differs on purpose (cast targets outside a strict allowlist
  are rejected up front rather than forwarded to PostgreSQL). See PARITY.md.
