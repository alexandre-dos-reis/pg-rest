# Architecture

Two packages, one core. `@tsql/rest`'s `handle()` is the HTTP front door; `@tsql/query`'s `query()` takes an object.
They meet as soon as the query parameters exist and share everything after that — parsing, planning, SQL, the
transaction, the error mapping — which lives in `packages/core`, a private package that each of the two bundles. A
feature or a fix in the core lands in both; what is only HTTP (content negotiation, `Range`, OpenAPI, plans) never
reaches `@tsql/query`, and what is only an extension of PostgREST never reaches `@tsql/rest`.

```
                      ┌─ handleRequest ─ URL, headers, body, content negotiation
                      │
[key, value][] ──▶ parseQuery ──▶ ParsedQuery ──▶ planTable / planRpc ──▶ execute ──▶ Outcome
                      │                              (SQL builders)      (one transaction)
                      └─ query() ─ an object, rendered into the same parameters
```

- [A request, step by step](#a-request-step-by-step)
- [Where things live](#where-things-live)
- [The schema cache](#the-schema-cache)
- [Errors](#errors)
- [Invariants worth knowing](#invariants-worth-knowing)

## A request, step by step

1. **Route and negotiate** (`handleRequest`, in `@tsql/rest`). The method, the path (minus `basePath`) and the headers decide the
   target (`/table`, `/rpc/fn`, or the OpenAPI root), the schema (`Accept-Profile` / `Content-Profile`), the
   preferences (`Prefer`), the output format (`Accept`, including CSV, GeoJSON, custom media types and plans) and the
   range. The body is parsed for a write.
2. **Parse the query** (`parse/*`). `parseQuery` turns the query parameters into a `ParsedQuery`: a `select` tree
   (columns, aliases, casts, JSON paths, aggregates, embedded resources with their hints and join type), the filters as
   a tree, order, paging, `on_conflict` and `columns`. The grammars follow PostgREST's Parsec ones, including where they
   stop and ignore the rest of a malformed value.
3. **Plan** (`core.planTable` / `core.planRpc` + `sql/*`). The relation or function is resolved against the schema
   cache, relationships through `resolveRelationship`, and the SQL is built: `sql/read` for selects and embeds,
   `sql/write` for insert/update/delete/upsert, `sql/rpc` for a function call, `sql/filters` for the `WHERE`, and
   `sql/statement` to wrap it all into **one** statement that returns the body, the page total, the count and the
   response GUCs. The rendering happens in Postgres (`json_agg`, `ST_AsGeoJSON`, a CSV aggregate), so the handler
   forwards text rather than re-serialising rows.
4. **Execute** (`core.execute`). One transaction on one connection:
   `SET TRANSACTION READ ONLY` for a read, then one `set_config` statement for the role, the claims, the `search_path`
   and your settings, then `preRequest` if you declared one, then the statement. `Prefer: tx=rollback` and a plan
   request roll back instead of committing, and a serialization failure (`40001`) is retried twice, since the whole
   transaction rolled back.

   Inside a scope (`transaction()`, `query.runTransaction`) the transaction is already open and already carries the
   identity: `Env.session` is set, so this step posts its statements there instead of calling `adapter.transaction`,
   and issues only the half of the `set_config` that is per statement — the `search_path`, the `request.*` settings and
   the time zone. `READ ONLY` and the replay belong to the scope, which is the only thing holding the boundary.
5. **Outcome** (`core.buildOutcome`). The status (`201`, `204`, `206`, `416`…) and the headers PostgREST's logic
   decides: `Content-Range`, `Location`, `Preference-Applied`, and the headers and status a function set through
   `response.headers` / `response.status`; plus the body. Nothing here is a `Response`.
6. **Dress it for the transport.** `@tsql/rest` adds what is only HTTP (`Content-Type` from the negotiated format,
   `Vary`), drops the body where HTTP says there is none (`HEAD`, `204`) and makes the `Response`.

`query()` enters at step 2 with parameters it renders from the object, builds the same plan, runs the same `execute`,
and reads the outcome into `{ data, count, status }`: the count is the total in its `Content-Range`. The HTTP-only
parts — content negotiation, `Range`, plans, `OPTIONS`, OpenAPI, cookies and request headers — are `@tsql/rest`'s.

`transaction()` (`packages/query/src/query.ts`) wraps that: it opens the transaction itself, issues the identity once, and runs each
`tx.query` through the very same steps on the session it holds. A nested scope is a `SAVEPOINT` around the same thing.

## Where things live

| path | |
| --- | --- |
| `packages/rest/src/index.ts` | `@tsql/rest`: `createRest` and its options; the instance gives `handle`, `schemaCache`, `reloadSchema`, `close` |
| `packages/rest/src/http.ts` | `handleRequest`: routing, content negotiation, the headers and cookies SQL will read, and the `Response` made out of an outcome; the HTTP-only settings |
| `packages/rest/src/request.ts` | reading HTTP: the method, the path, `Prefer`, `Range`, `Accept` (the negotiated format), the body (JSON, form, CSV) |
| `packages/rest/src/render.ts` | the SQL of the formats beyond JSON — CSV, GeoJSON, custom media type handlers — and how a negotiated format becomes what the engine is told |
| `packages/rest/src/serve.ts` | `handleSafely` and the error response |
| `packages/rest/src/media.ts`, `openapi.ts` | custom media type handlers, and the Swagger 2.0 document |
| `packages/query/src/index.ts` | `@tsql/query`: `createQuery` (on a generated `schema`) and the instance: `query`, `setContextQuery`, `transaction`, `close` |
| `packages/query/src/query.ts` | the object API: `QueryInput` → query parameters, `QueryError`, and the transaction scope |
| `packages/query/src/kinds.ts` | the error kinds (`invalid_query`, `conflict`, `no_context`, `rolled_back`…) a `QueryError` carries |
| `packages/query/src/typed.ts` | types only: the typed input and the result inference over a generated database type |
| `packages/query/src/types.ts` | build-time: `introspect`, `generateTypes`, `generateSchema`, `generateModule`, published as `@tsql/query/types` |
| `packages/core/src/core.ts` | planning, the transaction, and the `Outcome` (status, the headers PostgREST's logic decides, body): what both entry points run |
| `packages/core/src/parse/request.ts` | the types of a request, whatever carried it: `Method`, `Preferences`, `OutputFormat` (JSON, or a body rendered by SQL the caller supplies) |
| `packages/core/src/engine.ts` | the options both share, the adapter wrapper and the first schema read |
| `packages/core/src/parse/*` | the query string: `select`, filters and logic trees, fields and JSON paths, request headers, and the parser combinators the grammars are written with |
| `packages/core/src/sql/*` | SQL generation: `read`, `write`, `rpc`, `filters`, `statement`, and `expression` (the computed `set`) |
| `packages/core/src/schema.ts` | introspection (`pg_catalog`), the cache, and relationship resolution |
| `packages/core/src/service.ts` | the schema store (serialised reloads) and error mapping |
| `packages/core/src/errors.ts` | `PgRestError`, `ApiError`, `DbQueryError`, the SQLSTATE → status table, the `PT`/`PGRST` `RAISE` conventions |
| `packages/core/src/quote.ts` | identifier and literal quoting — every identifier goes through it |
| `packages/core/src/adapter.ts`, `adapters/*` | the driver interface and the four adapters (each package re-exports them) |

The dependency runs one way: `rest` and `query` import `core`, and `core` imports neither. `core` is a workspace package
with no build of its own; `tsdown` bundles it into each published package, which is why neither depends on a third one.

## The schema cache

`createRest` introspects `pg_catalog` at startup, so a connection or catalog problem surfaces there. `createQuery` does not:
it runs on a **schema descriptor**, the same cache as plain data, written at build time by `generateModule()` and read
back by `fromDescriptor()` without any check — the compiler is what holds a query to it. The cache holds
relations with their columns (types, nullability, defaults, identity, enum labels, the table column a view column is
read from), primary keys and unique constraints, what each relation accepts (`pg_relation_is_updatable`), foreign keys —
**including the ones that travel through views** — functions with their arguments and return shapes, and the custom
media type handlers.

It is what every later decision reads: whether a table exists (with a did-you-mean), whether an embed
resolves and in which direction, what an insert may contain, which arguments a function overload takes — and it is what
`generateModule()` describes, which is why the types cannot disagree with the runtime.

`reloadSchema()` of `createRest` re-reads it; for `createQuery`, regenerate the module. Reloads are serialised, and a failed one keeps the previous cache rather than leaving the
handler without one.

## Errors

The pure layers throw `PgRestError` (status, `PGRSTxxx` code, details, hint). Adapters' failures become `DbQueryError`,
normalised by SQLSTATE from whatever the driver throws. At the boundary, `toApiError` maps either — plus connection
failures and unexpected errors — to an `ApiError`: a status and a body shaped exactly like PostgREST's
`{ code, message, details, hint }`.

Then it is only a matter of how it reaches you: `handle()` serialises it into a response. `query()` never sees an
`ApiError`: `describeFailure` in `core/kinds.ts` classifies the same failure as a `kind` and hands over its `message`,
`details`, `hint` and SQLSTATE, and `QueryError` puts them, with the input attached, in the `error` of its result.
Neither is a rejection.

## Invariants worth knowing

They are the kind that break quietly, so each has a test that fails loudly:

- **One pipeline.** A feature must come from the shared code, not from one entry point. `tests/query.test.ts` asserts
  `query()` and `handle()` answer identically, error bodies included.
- **PostgREST's behaviour is the specification.** `tests/compare` replays hundreds of requests against the real
  PostgREST 16.5 binary on the same database and compares statuses, headers and bodies.
- **Values are data.** Parameters are text with an explicit `$n::text` cast; identifiers go through `packages/core/src/quote.ts`.
  `tests/security.test.ts` is the guard. → [`security.md`](security.md)
- **One union member per table** in `packages/query/src/typed.ts`, and every member declares `table`. Otherwise the editor silently
  starts offering every table's columns while the compiler stays right; `tests/completions.test.ts` asks the language
  service and pins it. → [`types.md`](types.md#in-your-editor)
- **The generated types compile, and are what the generator produces.** `tests/support/fixture.types.ts` is committed;
  one test pins it byte for byte and `bun run typecheck` compiles it.
- **The documentation compiles.** Every TypeScript block in `docs/` and in the README is type-checked by
  `tests/docs.test.ts` against the fixture's generated types.
