---
"@tsql/rest": minor
"@tsql/query": minor
---

**Breaking:** `@adrdp/pg-rest` is split in two, along the line that was already in the code.

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
