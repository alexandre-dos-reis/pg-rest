# Architecture

Two packages, one core. `@tsql/rest`'s `handle()` is the HTTP front door; `@tsql/query`'s operations (`select`, `insert`...) take an object.
They meet as soon as the query parameters exist and share everything after that — parsing, planning, SQL, the
transaction, the error mapping — which lives in `packages/core`, a private package that each of the two bundles. A
feature or a fix in the core lands in both; what is only HTTP (content negotiation, `Range`, OpenAPI, plans) never
reaches `@tsql/query`, and what is only an extension of PostgREST never reaches `@tsql/rest`.

```
   rest:  [key, value][] ──▶ parseQuery (grammars) ─┐
                                                    ├─▶ ParsedQuery ──▶ planTable / planRpc ──▶ execute ──▶ SqlResult
   query: an object ──────▶ toParsed ────────────────┘                    (SQL builders)      (one transaction)
```

- [How each package consumes the core](#how-each-package-consumes-the-core)
- [A request, step by step](#a-request-step-by-step)
- [Where things live](#where-things-live)
- [The schema cache](#the-schema-cache)
- [Errors](#errors)
- [Invariants worth knowing](#invariants-worth-knowing)

## How each package consumes the core

The core is a library of steps with no front door of its own: it knows nothing of `Request`, `Response`, cookies or a
status code, and it holds no PostgREST error code. Each package imports the steps it needs (`@tsql/core/*`, resolved to
`packages/core/src` and bundled by `tsdown`), feeds them in its own terms, and turns what comes out back into its own.
`rest` and `query` never import each other.

```
        @tsql/rest                         packages/core                         @tsql/query
 ┌─────────────────────┐        ┌──────────────────────────────┐        ┌─────────────────────┐
 │ Request             │        │                              │        │ a query object      │
 │  └ http.ts, request │        │  ParsedQuery (the IR)        │        │  └ query.ts         │
 │     parseQuery:     │──────▶ │  planTable / planRpc (sql/*) │ ◀──────│     toParsed: built │
 │     the grammar     │ parsed │  execute  ─▶ SqlResult       │ parsed │     from the object,│
 │     (route, Accept, │SqlCall │  schema cache, adapters      │SqlCall │     no text, no     │
 │      Prefer, Range, │ format │                              │ format │     grammar)        │
 │                     │ format │                              │ format │                     │
 │ Response  ◀─ toResponse ◀─ buildOutcome ◀── SqlResult {body, …}  ▶ { data, count, error } │
 │ ApiError  ◀─ toApiError ◀──── EngineError(reason), DbQueryError ───▶ QueryError(kind)     │
 └─────────────────────┘        └──────────────────────────────┘        └─────────────────────┘
```

What each side hands the core, and what it takes back:

| | `@tsql/rest` | `@tsql/query` |
| --- | --- | --- |
| **Engine** | `createEngine(options)`: reads the catalog at startup; `reloadSchema()` reads it again | `createStaticEngine(options, fromDescriptor(schema))`: never reads the catalog; the descriptor is generated at build time |
| **Input** | the URL's `[key, value][]`, headers and body, parsed by `parseQuery` (`rest/src/parse`, where PostgREST's grammars and the parser combinators live) into a `ParsedQuery` | an object, built into the same `ParsedQuery` by `toParsed` (`query.ts`): no query string is made or read, and no grammar is in the package. `packages/query/tests/query-direct.test.ts` pins that it gives what `rest`'s parser reads from the equivalent string |
| **Output format** | `Negotiated` (`json`, `object`, `csv`, `geojson`, `handler`, `openapi`, `plan`) from `Accept`, turned by `toEngineFormat` into the core's `json` / `object` / `rendered { sql }`; the CSV, GeoJSON and handler SQL is `rest`'s (`render.ts`) | `json`, or `object` with `single` |
| **SqlCall** | `{ settings, before }`, built in `rest/src/http.ts`: the `request.*` settings (`requestSettings`) and `preRequest`, which is told the `Request` | `{ before }` only, built in `query.ts` from `preRequest`, which is told the role, claims, method and path: there is no request, so no `request.*` setting |
| **Planning and execution** | `planTable` / `planRpc`, then `execute` | the same calls, on the same code |
| **What comes back** | a `SqlResult` (`body`, `rows`, `total`, `settings`, `noneInserted`), which `buildOutcome` (`rest/src/outcome.ts`) turns into an `Outcome` (`status`, `headers`, `text`), and `toResponse` adds `Content-Type`, `Vary`, `HEAD`, `bytea` and makes the `Response` | the same `SqlResult`: `shownBody(plan, body)` is `JSON.parse`d into `data`, and `total` is the `count`. There is no status and no header |
| **Failures** | `EngineError.reason` and SQLSTATE become a PostgREST status and `PGRSTxxx` code in `toApiError` (`rest/src/errors.ts`) | `EngineError.reason` and SQLSTATE become a `kind` in `describeFailure` (`query/src/kinds.ts`) |
| **Beyond one call** | content negotiation, `Range`, plans, `OPTIONS`, the OpenAPI document, custom media types | `transaction()` and `setContextQuery()`; the typed layer; at build time `introspect` and the generators (`types.ts`) |

Three consequences worth remembering. A change to parsing, planning, SQL or `execute` is a change to both packages,
and the comparison against PostgREST (`packages/rest/tests/compare`) pins it for `rest` while the `query` suites pin it for `query`.
A new way for the engine to refuse something is a new `Reason`, which has to be mapped by both packages (the compiler
checks it). And a feature that exists for one transport only is not in the core: the core's `SqlCall` and
`SqlOutputFormat` have no field for it: `SqlCall` is only settings to issue and something to run in the transaction, and each package
builds its own.

A naming rule keeps the core readable as SQL, not HTTP: a type of the core that a transport could mistake for its own
carries a `Sql` prefix (`SqlRequestContext`, `SqlQueryParams`, `SqlCall`, `SqlResult`, `SqlPlan`, `SqlEnv`, `SqlOperation`,
`SqlPreferences`, `SqlOutputFormat`). The packages keep their public names: `@tsql/rest` and `@tsql/query` export
`SqlRequestContext` as `RequestContext`.

## A request, step by step

1. **Route and negotiate** (`handleRequest`, in `@tsql/rest`). The method, the path (minus `basePath`) and the headers decide the
   target (`/table`, `/rpc/fn`, or the OpenAPI root), the schema (`Accept-Profile` / `Content-Profile`), the
   preferences (`Prefer`), the output format (`Accept`, including CSV, GeoJSON, custom media types and plans) and the
   range. The body is parsed for a write.
2. **Parse the query** (`rest/src/parse/*`). `parseQuery` turns the query parameters into a `ParsedQuery` (the engine's own input, defined in `core/src/parse/filter.ts`; `@tsql/query` builds one from its object instead): a `select` tree
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
   and your settings, then the call's `before` (that is `preRequest`, if you declared one), then the statement. `Prefer: tx=rollback` and a plan
   request roll back instead of committing, and a serialization failure (`40001`) is retried twice, since the whole
   transaction rolled back.

   Inside a scope (`transaction()`, `query.runTransaction`) the transaction is already open and already carries the
   identity: `SqlEnv.session` is set, so this step posts its statements there instead of calling `adapter.transaction`,
   and issues only the half of the `set_config` that is per statement — the `search_path`, the call's own `settings` (the
   `request.*` ones, for `rest`) and the time zone, then the call's `before`. `READ ONLY` and the replay belong to the scope, which is the only thing holding the boundary.
5. **SqlResult** (`core.execute` returns it). The rows the statement made (`body`), how many (`rows`), the count the call asked for
   (`total`, per `Preferences.count`), the settings the plan asked to read afterwards (`settings`) and whether an upsert
   inserted nothing (`noneInserted`). Nothing is parsed and nothing is HTTP. `range_not_satisfiable` is raised here,
   since it is about the offset and the count.
6. **Outcome** (`rest/src/outcome.ts`, `buildOutcome`). `@tsql/rest` alone turns the `SqlResult` into PostgREST's answer: the
   status (`201`, `204`, `206`…), `Content-Range`, `Location`, `Preference-Applied`, the headers and status a function set
   through `response.headers` / `response.status` (it asks for those two settings with `SqlQueryParams.read`, and a malformed
   one is a `PgRestError`).
7. **Dress it for the transport.** `@tsql/rest` adds what is only HTTP (`Content-Type` from the negotiated format,
   `Vary`), drops the body where HTTP says there is none (`HEAD`, `204`) and makes the `Response`.

The operations enter at step 2 with the `ParsedQuery` it builds from the object, builds the same plan, runs the same `execute`,
and reads the `SqlResult` into `{ data, count, error }`: `count` is its `total`. The HTTP-only
parts — content negotiation, `Range`, plans, `OPTIONS`, OpenAPI, cookies and request headers — are `@tsql/rest`'s.

**What a transport adds to a call.** The engine does not know `preRequest` and does not know the `request.*` settings
(`request.method`, `request.path`, `request.headers`, `request.cookies`: PostgREST's HTTP contract). `execute` takes a
`SqlCall` — `settings`, which it issues with the `set_config` of the statement, and `before`, which it runs in the transaction
right after — and says nothing about what they are. `rest` builds its `SqlCall` from the `Request` (`callOf`, in `http.ts`):
the `request.*` settings, and a `before` that runs `preRequest`, told the `Request`. `query` builds its own (`callOf`, in
`query.ts`): no settings, and a `before` that runs the same option, told only the role, claims, operation and path, since
there is no request. `identityOf` is how either learns the role and claims the engine will apply. What stays in the core
is the connection, the transaction, the identity, the SQL and the reporting of connection and SQL errors, and the count.
The core has no HTTP method (`planTable` takes an `SqlOperation`: `read`, `insert`, `update`, `delete`, `put`; `planRpc` takes
whether the function may write), no `Prefer` header (`SqlPreferences` is what the engine understands of it; `tx` and the
unparsed tokens are `rest`'s `Prefer`), and no response: `Outcome`, `appliedHeader` and the `response.*` settings are `rest`'s.

`transaction()` (`packages/query/src/query.ts`) wraps that: it opens the transaction itself, issues the identity once, and runs each
`tx`'s operations through the very same steps on the session it holds. A nested scope is a `SAVEPOINT` around the same thing.

## Where things live

| path | |
| --- | --- |
| `packages/rest/src/index.ts` | `@tsql/rest`: `createRest` and its options; the instance gives `handle`, `schemaCache`, `reloadSchema`, `close` |
| `packages/rest/src/http.ts` | `handleRequest`: routing, content negotiation, the `SqlCall` (`request.*` settings and `preRequest`), and the `Response` made out of an outcome; the HTTP-only settings |
| `packages/rest/src/request.ts` | reading HTTP: the method, the path, `Prefer`, `Range`, `Accept` (the negotiated format), the body (JSON, form, CSV) |
| `packages/rest/src/outcome.ts` | `Outcome`, `buildOutcome` (status, `Content-Range`, `Location`, `Preference-Applied`), the `response.*` settings, `appliedHeader` |
| `packages/rest/src/render.ts` | the SQL of the formats beyond JSON — CSV, GeoJSON, custom media type handlers — and how a negotiated format becomes what the engine is told |
| `packages/rest/src/errors.ts` | `PgRestError`, `ApiError`, the `reason` → status and `PGRSTxxx` table, the SQLSTATE → status table, the `PT`/`PGRST` `RAISE` conventions |
| `packages/rest/src/serve.ts` | `handleSafely` and the error response |
| `packages/rest/src/media.ts`, `openapi.ts` | custom media type handlers, and the Swagger 2.0 document |
| `packages/query/src/index.ts` | `@tsql/query`: `createQuery` (on a generated `schema`) and the instance: `select`, `insert`, `upsert`, `update`, `delete`, `rpc`, `setContextQuery`, `transaction`, `close` |
| `packages/query/src/query.ts` | the object API: `QueryInput` → `ParsedQuery`, the `SqlCall` (`preRequest`), prepared queries, `QueryError`, and the transaction scope |
| `packages/query/src/kinds.ts` | the error kinds (`invalid_query`, `conflict`, `no_context`, `rolled_back`…) a `QueryError` carries, and how an engine or database error becomes one |
| `packages/query/src/typed.ts` | types only: the typed input and the result inference over a generated database type |
| `packages/query/src/types.ts` | build-time: `introspect`, `generateTypes`, `generateSchema`, `generateModule`, published as `@tsql/query/types` |
| `packages/core/src/core.ts` | planning, the transaction (`execute`, which takes a `SqlCall` and returns a `SqlResult`), the identity (`identityOf`), the count: what both entry points run |
| `packages/core/src/parse/sql-options.ts` | the types of a call, whatever carried it: `SqlOperation`, `SqlPreferences`, `SqlOutputFormat` (JSON, or a body rendered by SQL the caller supplies) |
| `packages/core/src/engine.ts` | the options both share, the adapter wrapper and the first schema read |
| `packages/core/src/parse/*` | what the engine takes in, without any syntax of its own: `ParsedQuery` and its parts (`filter.ts`), the hand-written readers of a column, a `select` item and an order term (`field.ts`, `select.ts`), the operator vocabulary (`syntax.ts`) and the request types |
| `packages/rest/src/parse/*` | PostgREST's query string: the Parsec-style combinators (`parsec.ts`), the grammars that give its error messages (`grammar.ts`) and `parseQuery` (`query-string.ts`) |
| `packages/core/src/sql/*` | SQL generation: `read`, `write`, `rpc`, `filters`, `statement`, and `expression` (the computed `set`) |
| `packages/core/src/schema.ts` | introspection (`pg_catalog`), the cache, and relationship resolution |
| `packages/core/src/service.ts` | the schema store (serialised reloads) |
| `packages/core/src/errors.ts` | `EngineError` (a `reason`, no code, no status), `DbQueryError`, `isConnectionError` |
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

The core has no wire format. Its pure layers (parsers, planners, SQL builders) throw `EngineError`, which carries a
`reason` — `table_not_found`, `not_single_row`, `invalid_input`… — with a message, details and a hint, and nothing
else. Adapters' failures become `DbQueryError`, normalised by SQLSTATE from whatever the driver throws.

Each package then consumes them on its own. `@tsql/rest`'s `toApiError` maps a reason to the PostgREST status and
`PGRSTxxx` code it answers with, a SQLSTATE to a status, and connection failures and unexpected errors to an
`ApiError`: a status and a body shaped exactly like PostgREST's `{ code, message, details, hint }`, which `handle()`
serialises into a response. `@tsql/query`'s `describeFailure` maps the same failures to a `kind` and hands over the
`message`, `details`, `hint` and SQLSTATE; `QueryError` puts them, with the input attached, in the `error` of its
result. Neither is a rejection, and neither package knows the other's mapping.

## Invariants worth knowing

They are the kind that break quietly, so each has a test that fails loudly:

- **One pipeline.** A feature must come from the shared code, not from one entry point. the shared `ParsedQuery` fixtures assert
  the operations and `handle()` answer identically, error bodies included.
- **PostgREST's behaviour is the specification.** `packages/rest/tests/compare` replays hundreds of requests against the real
  PostgREST 16.5 binary on the same database and compares statuses, headers and bodies.
- **Values are data.** Parameters are text with an explicit `$n::text` cast; identifiers go through `packages/core/src/quote.ts`.
  the two `security.test.ts` suites are the guard. → [`security.md`](security.md)
- **One union member per table** in `packages/query/src/typed.ts`, and every member declares `table`. Otherwise the editor silently
  starts offering every table's columns while the compiler stays right; `packages/query/tests/completions.test.ts` asks the
  compiler and pins it. → [`types.md`](types.md#in-your-editor)
- **The generated types compile, and are what the generator produces.** `tests/support/fixture.types.ts` is committed;
  one test pins it byte for byte and `bun run typecheck` compiles it.
- **The documentation compiles.** Every TypeScript block in `docs/` and in the README is type-checked by
  `tests/docs.test.ts` against the fixture's generated types.
