# pg-rest

## 0.5.0

### Minor Changes

- 894a00f: A transaction across several `query()` calls.

  Every call opened its own transaction, which is right for a request and was the whole story for `handle()`. But
  `query()` is called from application code, where two writes that must land together are ordinary, and the answer was to
  leave the library — run the SQL yourself, and lose the parser, the embedding and the error mapping for those two
  statements. `transaction(fn, ctx)` is one scope, one transaction:

  ```ts
  const { data, error } = await pgRest.transaction(
    async (tx) => {
      const order = await tx.query({ table: "orders", action: "insert", rows: { client_id: 1 }, single: true });
      await tx.query({ table: "order_items", action: "insert", rows: itemsFor(order.data.id) });
      return order.data.id; //                this is the result's `data`
    },
    { role: "authenticated", claims: { sub: user.id } },
  );
  ```

  It answers a `QueryResult` around whatever the callback returned (`data` is that value, there is no `count`) and never
  rejects, like `query()`. Both entry points carry it: `pgRest.transaction(fn, ctx)`, and `pgQuery.transaction(fn)` on a
  bound query, which reads its context source **once, on entry**.

  `tx.query` differs from `query` in exactly two ways, and both of them follow from sharing a transaction.

  - **It takes no context, and cannot.** The role and the claims are `set_config(…, true)`, transaction-local and issued
    once at the head of the transaction; re-issuing them halfway through scopes nothing. A context passed to `tx.query`
    is a type error rather than an argument quietly ignored — the per-call override moves to the scope, which is the
    granularity `set_config` works at: `pgQuery.transaction(fn, { role: "admin" })`.
  - **It rejects on failure instead of answering an `error`.** A query that failed is a transaction that will not commit,
    so leaving is the only correct next step and the library takes it rather than asking every call site to. What comes
    back is therefore the success — `data` is not null, `count` is the number the query asked for, and
    `if (error) throw error` disappears. The promise that never rejects moved from the query to the **scope**, where it
    is the only one that can mean anything. What it throws is the same `QueryError` `query()` would have returned.
  - **Any failed query stops the scope from committing**, even when a `catch` swallowed it and the callback returned a
    value: `single` and `maxAffected` are checks raised _after_ a statement that worked, and a scope that committed would
    keep the row and report it as refused. The first failure is what the result carries, and a query issued after one is
    refused with `PGRSTX03` rather than PostgreSQL's `25P02`.
  - **`tx.transaction(fn)`** is a nested scope on a `SAVEPOINT`, and the one place a transaction may carry on after a
    failure — so unlike `tx.query` it answers a `QueryResult` rather than rejecting: a query that is _allowed_ to fail
    goes in one, and its failure is an `error` you read. **`tx.rollback()`** undoes the scope it is called in and leaves
    it (`PGRSTX02`).
  - **`readOnly`**, **`isolationLevel`** and **`retry`** are per-transaction, so the scope decides them rather than
    whichever query went first: `{ readOnly: true }` and `{ isolationLevel: "serializable" }` go in as the transaction's
    first statement, and `{ retry: { attempts, on, delayMs } }` replays the scope on a serialization failure — off by
    default, because replaying the transaction means replaying your callback. `"read uncommitted"` is not among the
    levels: PostgreSQL accepts it and runs `read committed` anyway.

  `QueryErrorKind` gains `"rolled_back"` for the two codes above; a `switch` on `kind` with a `default` is unaffected.
  `ContextQuery` and `TypedContextQuery<Db>` become callable interfaces carrying `transaction`, which is additive since
  both are only ever return types. Driver errors are now normalised per statement rather than on the way out of a
  transaction, so a failure caught inside a scope still carries its SQLSTATE.

  [`examples/with-transactions`](examples/with-transactions) runs all of it end to end, with the caller read from an
  `AsyncLocalStorage`. Joining a transaction the _application_ opened is the other half, still in
  [`docs/proposals.md`](docs/proposals.md).

## 0.4.0

### Minor Changes

- e1e0957: `query()` errors say what went wrong in a way both a program and a person can read.

  The `error` of a result carried the PostgREST body and nothing else to branch on: `code` is exact — a `PGRSTxxx` code or
  a SQLSTATE — but there are dozens of them, so telling "the row already exists" from "you are not signed in" meant
  keeping a table of codes on the calling side. Two additions, and nothing removed:

  - **`error.kind`**, a closed string union (`QueryErrorKind`) every code maps onto: `invalid_query`, `invalid_payload`,
    `undefined_object`, `invalid_embed`, `not_single_row`, `too_many_affected`, `unauthenticated`, `forbidden`,
    `conflict`, `invalid_data`, `raised`, `unsupported`, `unavailable`, `no_context`, `internal`. The members are the
    cases that call for _different reactions_, so a `switch` on it is exhaustive-checked by the compiler. `code` is still
    there for the exact reason. The mapping is exported for an `ApiError` held from `handle()` too: `errorKind(status,
    code)`, with `describeErrorKind(kind)` for its wording.
  - **`error.summary`**, the same failure written out for whoever reads it — the call it came from, then what the parser
    or the database said, then `details`, `hint` and the kind, each on its own line:

    ```
    insert on "clients" failed: duplicate key value violates unique constraint "clients_email_key"
      details: Key (email)=(ada@example.com) already exists.
      kind: conflict -- a unique or foreign key constraint rejected the row (23505, HTTP 409)
    ```

  `error.message` keeps the one-line `"23505: duplicate key … hint: …"` form, and `error.body` stays exactly the JSON
  PostgREST answers with: both are what they were, so nothing that reads them has to change.

## 0.3.0

### Minor Changes

- 9484100: Composite types are first class: in `query()`, in the SQL, and in the generated types.

  A column of a [composite type](https://www.postgresql.org/docs/current/rowtypes.html) could already be read and written
  — Postgres hands it over as a nested object, and `json_populate_record` writes one back — but its _fields_ were out of
  reach, and the generated types called it `unknown`. Three changes:

  - **`->`/`->>` into a composite column** (nested, and through an array of them) now work in `select`, `where` and
    `order`, as they do on `jsonb`. pg-rest converts the column with `to_jsonb()` first unless its type is exactly
    `json`/`jsonb` — which is PostgREST's own rule, and was a **parity gap**: `select=owner->>name` answered
    `42883 operator does not exist` where PostgREST answers the field. The same rule applies to arrays and scalars, so
    `select=id->>nope` now answers `null` instead of an error, again like PostgREST.
  - **Comparing a whole composite value**, which is pg-rest's own: `where: { owner: { name: "Ada", home: { city: "Paris" } } }`
    sends the value as JSON and turns it into a row of the column's type. The fields may come in any order and the ones
    left out are NULL, exactly like the row literal it stands for. An object is read as a value only when it has no `op`
    key, so the `{ op, value, not }` form is untouched. PostgREST answers `0A000` to any composite comparison (its
    literal has no type to be read as); a bare row literal still does here too.
  - **Generated types** describe the fields: one named type per composite type the schema reaches, nesting included, plus
    the types of a function's composite arguments and result. On the way in the fields are optional, since a value
    written or compared may leave them out. `SchemaCache` carries them under `composites`, and a column points at its
    type with `Column.composite`.

  Also fixed on the way, found by the new differential cases: a JSON path **ending on an index** is named after the last
  key before it (`select=tags->0` is `tags`, `data->1->mycol->>2` is `mycol`), as PostgREST names it — it used to be
  `0`/`2`. This affects `json`/`jsonb` columns too.

- 54b5bde: **Breaking:** `query()` hands failures back in the result, and `querySafe()` is gone.

  What `querySafe` did is what `query` does now, under the shorter name: `{ data, count, status, error }`, exactly one of
  `data` and `error` set, and it **never rejects** — not even on a failure the library did not foresee, which arrives as a
  500 `error` carrying the original under `cause`. One form instead of two, and no `try`/`catch` anywhere.

  ```ts
  const { data, error } = await pgRest.query({ table: "todos", select: ["id"] });
  if (error) return c.json(error.body, error.status);
  // data is narrowed from here on
  ```

  To migrate: rename `querySafe` to `query`, and replace a `try`/`catch` around `query` with `if (error)`. `error` is the
  same `QueryError` the throwing form raised, so what you do with it does not change. The types follow: `QuerySafeResult`
  is gone, `QueryResult` is now the union, and its two halves are exported as `QueryOk` and `QueryFailed`.

  Also: `count` is typed from the `count` the query asked for, instead of always being `number | undefined`.

  ```ts
  const { data, count, error } = await pgRest.query({ table: "todos", select: ["id"], count: "exact" });
  if (error) throw error;
  // count: number -- asked for, so there is nothing to test for
  ```

  `"exact"` and `"estimated"` always answer with a number: when paging leaves nothing to look past, that number is the
  page's own length. `"planned"` stays `number | undefined`, because it reads `Plan Rows` out of an `EXPLAIN` which can
  come back with nothing usable. No `count` in the query is `undefined`, on both halves of the result. An instance created
  without a type argument keeps `number | undefined`, as before.

- 9b342a7: `setContextQuery(source)`: `query()` with the context decided once, so it stops being threaded through every layer that
  happens to run a query.

  `source` is either a fixed `RequestContext` or a function called at **every** call, which is what makes an
  `AsyncLocalStorage` work: one `db` at module scope serves a different caller for every request in flight.

  ```ts
  const store = new AsyncLocalStorage<RequestContext>();
  const db = pgRest.setContextQuery(() => store.getStore());

  app.use(async (c, next) => store.run({ role: "authenticated", claims: { sub: userId } }, next));

  const { data, error } = await db({ table: "todos", select: ["id", "title"] });
  ```

  pg-rest holds no store of its own — it stays dependency-free and runtime-neutral, and the context may come from
  anywhere. A context passed to the call wins over `source`, for one administrative query without leaving the scope. A
  `source` that returns nothing (the store was never entered) is a 500 `PGRSTX01` `error`, not a silent fall back to the
  anonymous role. With a generated database type the bound query is typed exactly like `query`, minus `ctx`.

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
