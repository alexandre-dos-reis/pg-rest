# @tsql/rest

## 0.1.0

### Minor Changes

- 2bd1d98: **Breaking:** `@adrdp/pg-rest` is split in two, along the line that was already in the code.

  - **`@tsql/rest`** is the PostgREST-compatible handler: `createRest(options)` gives `handle(Request) => Response`, with PostgREST's status codes, headers and error bodies. Nothing in it is an extension of PostgREST.
  - **`@tsql/query`** is the in-process API: `createQuery({ db, schema })` gives `query()`, `transaction()` and `setContextQuery()`, with the `$` filters and the computed `set` that PostgREST does not have. It has no HTTP in it, and nothing of PostgREST: its errors are its own (see below). The build-time generators are `@tsql/query/types`.

  They share one core (parsing, SQL, the schema cache, errors, adapters), which each package bundles: there is no third package to install. The adapters are in both, as `@tsql/rest/adapters/*` and `@tsql/query/adapters/*`.

  `createRest` reads the catalog itself and has `reloadSchema()`. `createQuery` never reads it: it runs on a **schema descriptor** generated at build time, together with the types, and does no runtime check of it — the compiler is what holds a query to it. `reloadSchema()`, `schemaCache()` and `generateTypes()` leave the query instance; `introspect`, `generateTypes`, `generateSchema` and `generateModule` are exported by `@tsql/query/types`.

  ```ts
  // build time
  writeFileSync("src/db.generated.ts", generateModule(await introspect(adapter, ["api"]), { name: "Database" }));

  // runtime
  import { schema } from "./db.generated";
  const rest = await createRest({ db, schemas: ["api"] });
  const query = createQuery<Database>({ db, schema });
  ```

  `createPgRest` is gone. The options both share (`db`, `schemas`, `anonymousRole`, `maxRows`, `extraSearchPath`, `preRequest`) are the same in both; `resolveContext`, `basePath`, `allowTxOverride`, `planEnabled`, `openApi`, `requestSettings` and `serverUrl` are `createRest`'s. `query()` no longer sets `request.method`, `request.path`, `request.headers` and `request.cookies` in SQL: they are PostgREST's HTTP contract, and there is no request.

  **Errors in `@tsql/query`.** A `QueryError` is no longer an `ApiError`: it has a `kind` (the string union), `message`, `details`, `hint`, the `sqlState` of a database error, and the `input`. There are no `PGRSTxxx` codes, no `status` and no `body` on it, and `QueryResult` has no `status` any more. `ApiError`, `DbQueryError`, `PgRestError`, `ErrorBody` and `errorKind` are no longer exported by `@tsql/query` (they stay in `@tsql/rest`). A transaction scope that rolled back, and a bound query with no context, are `rolled_back` and `no_context` errors.

### Patch Changes

- ef9a407: The engine no longer knows `preRequest` or the `request.*` settings: each package builds what it adds to a call (`@tsql/rest` from the HTTP request, `@tsql/query` from its own options). `preRequest` behaves as before; `PreRequestInfo.request` of `@tsql/query` is gone, since a query has no request.
- a9b8c23: The engine no longer has anything HTTP in it. `execute` returns a neutral `Result` (body, rows, total, the settings it was asked to read); `@tsql/rest` turns it into the status and headers (`Content-Range`, `Location`, `Preference-Applied`, `response.*`), and `planTable` takes an operation instead of an HTTP method. `@tsql/query` reads `total` directly instead of the `Content-Range` header. `PreRequestInfo.method` of `@tsql/query` is now `operation`.
- 4480352: Close an SQL injection and read hostile names the way PostgREST does.

  - `@tsql/query`: the `nulls` of an `order` object was written into the statement as it came, so a value that did not go through the type (a JSON body, say) could add SQL after `NULLS`. It now has to be `"first"` or `"last"`. `table`, `rpc` and `schema` must be strings: an object with its own `toString` is refused instead of being turned into a name.
  - `@tsql/rest`: the key of a filter, an embedded filter, a function argument read from the query string, `columns` and `on_conflict` go through PostgREST's grammar. What is not a name answers `PGRST100 failed to parse tree path (…)` (or `columns parameter`, `on_conflict parameter`) and what follows a name is ignored, as PostgREST does, instead of being looked for as a column (`42703`/`PGRST108`/`PGRST202`).
  - `@tsql/rest`: closer to PostgREST on malformed requests. `;` separates query parameters like `&`; `/table/` and `/rpc/` are read the way PostgREST reads them; an unsupported `Content-Type` is `400 PGRST102` (not 415) and an unsupported `Accept` is `406 PGRST107` listing the raw entries; function bodies that are not objects are read as PostgREST reads them (a scalar is no arguments, a single unnamed `json`/`text`/`xml`/`bytea` parameter takes the raw body); an empty `timezone` preference and an unknown `on_conflict` column answer with the PostgreSQL error. A NUL in a value is cut at the database boundary like libpq does, and embedded tables are aliased `<table>_<n>` so PostgreSQL error messages read like PostgREST's.

- 42f7660: The query-string parser does less work on the way to a successful parse: error messages are built only when one is reported, and combinators no longer allocate on every step. `parseQuery` on a typical query takes about a quarter less time; messages and results are unchanged.
- c8b433b: The query-string grammar (`parsec`, PostgREST's grammars and `parseQuery`) moves from the core into `@tsql/rest`, the only package that reads a query string. The engine now takes a `ParsedQuery`; `@tsql/query` builds it from its object for every shape -- JSON paths, casts, aggregates, embedded filters and null tests included -- and no longer renders a query string to have it parsed again, so the parser is no longer in its bundle. Two names a query string reserves (`order`, `limit`, `select`, `and`, `or`, `columns`) can now be columns in a `where`; an `$in` without a list, an unknown `$is` value and the like are refused in `query`'s own words.
