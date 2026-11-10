# @tspg/query

## 0.2.0

### Features

- efe55ed: create an instance from `schemas` alone, and generate from the same options

  `createQuery`'s `schema` descriptor is now optional. Given `schemas` instead, the instance reads the catalog itself —
  once, on its first operation, or on the new `ready()` — so a typed client is `createQuery<Db>({ db, schemas: ["api"] })`
  with no codegen step. A descriptor still means the catalog is never read, and the queries are typed the same either way.
  `ready()` is also what `prepare()` needs on an instance with no descriptor, since planning is synchronous.

  `@tspg/query/types` follows: `introspect`, `generateTypes`, `generateSchema` and `generateModule` each take
  `createQuery`'s own options as their single source, read the catalog themselves and return a promise, so a generator
  script is one call — `await generateTypes(options, { name: "Database" })`. They still accept a `SchemaCache` for a script
  writing several modules from one read.

## 0.1.0

### Minor Changes

- 0c32d76: **Breaking:** `where` filters are written with `$`-prefixed operators, the way MongoDB and Prisma-style libraries do.

  - `total: ["gte", 100]` and `total: { op: "gte", value: 100 }` become `total: { $gte: 100 }`. The two former forms are refused with an error that says what to write instead, rather than read as an equality.
  - Several operators on one column are ANDed: `{ $gte: 100, $lt: 500 }`.
  - `not` and `quantifier` become wrappers: `{ $not: { $in: [1, 2] } }`, `{ $any: { $like: ["a*", "b*"] } }`. Full-text takes its configuration in the value: `{ $fts: { query: "ada", config: "english" } }`.
  - `and` / `or` become `$and` / `$or`, and `$not: { … }` inverts a group. A column may now be called `and` or `or`.
  - To compare a column with an array, write `{ $eq: [...] }`: an array is no longer a condition on its own.
  - In typed queries, the operators a column accepts follow its type (`$like` on text, `$cs` on arrays, `$gt` on ordered types).
  - `FilterSpec` is replaced by `OperatorSpec`.

- 957e448: Typed queries accept a JSON path in a `where` (`{ "meta->>tier": { $ilike: "go*" } }`). A filter does not change the shape of the result, so the reason a `select` refuses a path does not apply; the column before `->` is still checked, and the value only for its shape.
- 77528a8: **Breaking:** `query()` is gone; each operation is a method of its own — `select`, `insert`, `upsert`, `update`, `delete` and `rpc` — and `action` is no longer a key.

  - `pgRest.query({ table: "todos", action: "insert", rows })` becomes `pgRest.insert({ table: "todos", rows })`; a read is `pgRest.select({ table })`, a function call `pgRest.rpc({ name: "add" })`. The input is the old one minus `action`, so nothing else changes — filters, `select`, `returning`, `single`, `count`, the optional `ctx`.
  - The same six methods are on a transaction scope (`tx.insert(...)`, which rejects on failure as `tx.query` did) and on what `setContextQuery()` returns, which is no longer callable: `db({ table })` becomes `db.select({ table })`.
  - The method decides the `action`, even if the object you pass has one: `select(input)` can never delete.
  - Typed instances check each operation against its own type: `rows` is required by `insert`/`upsert`, `set` by `update`, and the other methods refuse them. `TypedQuery` is replaced by `TypedSelect`, `TypedInsert`, `TypedUpsert`, `TypedUpdate`, `TypedDelete` and `TypedRpc`.
  - `prepare()` takes a function that returns a `select` (`SelectInput`).
  - A `QueryError`'s `input` now carries the `action` of the method that was called.
  - **`select` is `columns`.** `pgRest.select({ table, select: ["id"] })` becomes `pgRest.select({ table, columns: ["id"] })`, and the same in an embed's long form (`{ orders: { columns: [...], inner: true } }`) and in `rpc`.
  - On a write, the columns to return are `returning`, which now takes a list as well as `"representation"` and `"minimal"`: `pgRest.insert({ table, rows, returning: ["id"] })`. An insert's own `columns` (the columns it inserts) is unchanged, and `data` is typed from `returning` only.

- c38de44: `query()` passes the values of its filters to the driver as bound parameters (`$1`, `$2`…) instead of writing them into the SQL. The statement text now depends on the shape of the query and not on its values, so the driver and the server reuse the prepared statement and its plan instead of parsing a new text for every value, and a value is never part of the SQL at all. On a typical read that is about a third off the time of a call (`query()` ~450 µs -> ~300 µs, `run(prepared)` ~390 µs -> ~260 µs on the same machine); the statement itself goes from ~170-210 µs to ~60-70 µs.

  A value compared with a `json` or `jsonb` column, or with the result of a `->` path, stays a literal, because `Bun.sql` re-encodes a parameter it infers as json. `@tspg/rest` is unchanged: HTTP keeps the literals of its statements. The expressions of an update's `set` are still literals.

- 56304ba: `prepare()` plans a select once and gives back a function of its values: a call is string concatenation and the statement for the driver, with no parsing and no planning. A call is run with `run()` -- on the instance, on a `setContextQuery` function, or as `tx.run()` in a transaction -- and the query is typed and checked against the database like any other.

  ```ts
  const paidOver = pgRest.prepare((a: { status: string; min: number }) => ({
    table: "orders",
    where: { status: a.status, total: { $gte: a.min } },
  }));
  const { data } = await pgRest.run(paidOver({ status: "paid", min: 100 }), ctx);
  ```

  An argument is a filter value and nothing else (it cannot pick a column, an operator or a limit); `prepare()` throws at set-up time for a query that does not follow that, and for anything but a select. A call with `null`, a `*` wildcard or a composite value runs the ordinary way.

- f649257: **Breaking:** `rpc` names its function in `name`, not `rpc`: `pgRest.rpc({ rpc: "add", args })` becomes `pgRest.rpc({ name: "add", args })`. The method keeps its name; only the key changed, so `args`, `columns`, `where` and `order` are untouched.
- 2bd1d98: **Breaking:** `@adrdp/pg-rest` is split in two, along the line that was already in the code.

  - **`@tspg/rest`** is the PostgREST-compatible handler: `createRest(options)` gives `handle(Request) => Response`, with PostgREST's status codes, headers and error bodies. Nothing in it is an extension of PostgREST.
  - **`@tspg/query`** is the in-process API: `createQuery({ db, schema })` gives `query()`, `transaction()` and `setContextQuery()`, with the `$` filters and the computed `set` that PostgREST does not have. It has no HTTP in it, and nothing of PostgREST: its errors are its own (see below). The build-time generators are `@tspg/query/types`.

  They share one core (parsing, SQL, the schema cache, errors, adapters), which each package bundles: there is no third package to install. The adapters are in both, as `@tspg/rest/adapters/*` and `@tspg/query/adapters/*`.

  `createRest` reads the catalog itself and has `reloadSchema()`. `createQuery` never reads it: it runs on a **schema descriptor** generated at build time, together with the types, and does no runtime check of it — the compiler is what holds a query to it. `reloadSchema()`, `schemaCache()` and `generateTypes()` leave the query instance; `introspect`, `generateTypes`, `generateSchema` and `generateModule` are exported by `@tspg/query/types`.

  ```ts
  // build time
  writeFileSync("src/db.generated.ts", generateModule(await introspect(adapter, ["api"]), { name: "Database" }));

  // runtime
  import { schema } from "./db.generated";
  const rest = await createRest({ db, schemas: ["api"] });
  const query = createQuery<Database>({ db, schema });
  ```

  `createPgRest` is gone. The options both share (`db`, `schemas`, `anonymousRole`, `maxRows`, `extraSearchPath`, `preRequest`) are the same in both; `resolveContext`, `basePath`, `allowTxOverride`, `planEnabled`, `openApi`, `requestSettings` and `serverUrl` are `createRest`'s. `query()` no longer sets `request.method`, `request.path`, `request.headers` and `request.cookies` in SQL: they are PostgREST's HTTP contract, and there is no request.

  **Errors in `@tspg/query`.** A `QueryError` is no longer an `ApiError`: it has a `kind` (the string union), `message`, `details`, `hint`, the `sqlState` of a database error, and the `input`. There are no `PGRSTxxx` codes, no `status` and no `body` on it, and `QueryResult` has no `status` any more. `ApiError`, `DbQueryError`, `PgRestError`, `ErrorBody` and `errorKind` are no longer exported by `@tspg/query` (they stay in `@tspg/rest`). A transaction scope that rolled back, and a bound query with no context, are `rolled_back` and `no_context` errors.

- 46c15d8: `query()` can compute the columns of an `update` in the database, following PostgreSQL's `UPDATE … SET column = { expression | DEFAULT }`.

  ```ts
  set: {
    status: "paid",                                  // a plain value, as before
    total: { $add: [{ $col: "total" }, 10] },        // an expression
    placed_at: { $default: true },                   // DEFAULT
  }
  ```

  Operators are `$`-prefixed (`$add`, `$sub`, `$mul`, `$div`, `$mod`, `$pow`, `$concat`, comparisons, `$and`/`$or`/`$not`, `$cast`, `$coalesce`, …) and work on the types they work on in PostgreSQL. A fixed list of functions is there too (`$now`, `$lower`, `$upper`, `$trim`, `$length`, `$abs`, `$round`, `$arrayAppend`, `$arrayRemove`), and on a typed instance an expression has to give the column's type. Nothing is raw SQL: columns are checked against the schema, types against an allowlist, values are escaped.

  It is available in `query()` only: a plain `set` and the HTTP `PATCH` of `@tspg/rest` are unchanged. An object whose keys all start with `$` is read as an expression, so a `jsonb` value like that is written `{ $val: … }`.

### Patch Changes

- ef9a407: The engine no longer knows `preRequest` or the `request.*` settings: each package builds what it adds to a call (`@tspg/rest` from the HTTP request, `@tspg/query` from its own options). `preRequest` behaves as before; `PreRequestInfo.request` of `@tspg/query` is gone, since a query has no request.
- a9b8c23: The engine no longer has anything HTTP in it. `execute` returns a neutral `Result` (body, rows, total, the settings it was asked to read); `@tspg/rest` turns it into the status and headers (`Content-Range`, `Location`, `Preference-Applied`, `response.*`), and `planTable` takes an operation instead of an HTTP method. `@tspg/query` reads `total` directly instead of the `Content-Range` header. `PreRequestInfo.method` of `@tspg/query` is now `operation`.
- 4480352: Close an SQL injection and read hostile names the way PostgREST does.

  - `@tspg/query`: the `nulls` of an `order` object was written into the statement as it came, so a value that did not go through the type (a JSON body, say) could add SQL after `NULLS`. It now has to be `"first"` or `"last"`. `table`, `rpc` and `schema` must be strings: an object with its own `toString` is refused instead of being turned into a name.
  - `@tspg/rest`: the key of a filter, an embedded filter, a function argument read from the query string, `columns` and `on_conflict` go through PostgREST's grammar. What is not a name answers `PGRST100 failed to parse tree path (…)` (or `columns parameter`, `on_conflict parameter`) and what follows a name is ignored, as PostgREST does, instead of being looked for as a column (`42703`/`PGRST108`/`PGRST202`).
  - `@tspg/rest`: closer to PostgREST on malformed requests. `;` separates query parameters like `&`; `/table/` and `/rpc/` are read the way PostgREST reads them; an unsupported `Content-Type` is `400 PGRST102` (not 415) and an unsupported `Accept` is `406 PGRST107` listing the raw entries; function bodies that are not objects are read as PostgREST reads them (a scalar is no arguments, a single unnamed `json`/`text`/`xml`/`bytea` parameter takes the raw body); an empty `timezone` preference and an unknown `on_conflict` column answer with the PostgreSQL error. A NUL in a value is cut at the database boundary like libpq does, and embedded tables are aliased `<table>_<n>` so PostgreSQL error messages read like PostgREST's.

- 42f7660: The query-string parser does less work on the way to a successful parse: error messages are built only when one is reported, and combinators no longer allocate on every step. `parseQuery` on a typical query takes about a quarter less time; messages and results are unchanged.
- c8b433b: The query-string grammar (`parsec`, PostgREST's grammars and `parseQuery`) moves from the core into `@tspg/rest`, the only package that reads a query string. The engine now takes a `ParsedQuery`; `@tspg/query` builds it from its object for every shape -- JSON paths, casts, aggregates, embedded filters and null tests included -- and no longer renders a query string to have it parsed again, so the parser is no longer in its bundle. Two names a query string reserves (`order`, `limit`, `select`, `and`, `or`, `columns`) can now be columns in a `where`; an `$in` without a list, an unknown `$is` value and the like are refused in `query`'s own words.
- 2884832: `query()` no longer renders its object as a query string for the engine to parse again: the common shapes (plain columns, `$` operators, `$or`/`$and`/`$not`, order, paging, embedded resources) are built straight into the parsed form. The CPU `query()` spends before the statement goes to the driver drops from about 215 µs to about 18 µs on a typical query. A shape the shortcut does not cover (a JSON path, a cast, an aggregate, a dotted key) takes the old route, so results and errors are unchanged.
