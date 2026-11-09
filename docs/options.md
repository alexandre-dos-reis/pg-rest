# Options: `createRest` and `createQuery`

`createRest` (`@tsql/rest`) gives the HTTP handler and `createQuery` (`@tsql/query`) the in-process API. They take the
same options for the database and the role (the first group below); the second group is HTTP only, so only `createRest`
takes it. An app that uses both creates both, and each keeps its own schema cache.

```ts
const rest = await createRest({
  db: nodePostgresAdapter(pool),
  schemas: ["api"],
  anonymousRole: "anon",
  resolveContext: async (req) => {
    const user = await mySessionLookup(req);
    return user ? { role: "authenticated", claims: { sub: user.id } } : undefined;
  },
});
```

Introspection runs here, so a connection or catalog problem surfaces at startup rather than on the first request.

Introspection runs here, so a connection or catalog problem surfaces at startup rather than on the first request.

**Both** (`EngineOptions`): the database and the role.

| option | meaning |
| --- | --- |
| `db` | a `DbAdapter` built from your driver → [`adapters.md`](adapters.md) |
| `schemas` | the exposed schemas; the first is the default, the others are selected with `Accept-Profile` / `Content-Profile` or `schema:` in a query. Default `["public"]` |
| `anonymousRole` | the role for a call with no context. Default `"anon"`; `false` refuses anonymous calls with `401 PGRST302` |
| `maxRows` | a cap on the rows a read returns (PostgREST's `db-max-rows`) |
| `extraSearchPath` | schemas appended to `search_path` after the selected one. Default `["public"]` |
| `preRequest` | a SQL function name (`"auth.check"`) or a callback `(session, info) => Promise<void>`, run inside the request's transaction (`db-pre-request`). In a [transaction scope](query.md#transactions) it runs before every operation of `tx`, each with its own method and path. `info` is `{ role, claims, method, path }`; `createRest` adds the `request` (`@tsql/query` has none) |

**`createRest` only**: HTTP.

| option | meaning |
| --- | --- |
| `resolveContext(req)` | who is calling: return `{ role, claims, settings }`, or `undefined` for the anonymous role. Throw a `PgRestError` to reject outright. There is no JWT — use a cookie, an API key, your auth library |
| `basePath` | a URL prefix to strip, so the handler can be mounted anywhere (`/api/rest`) |
| `allowTxOverride` | honour `Prefer: tx=rollback` (`db-tx-end`). Default off |
| `planEnabled` | answer `Accept: application/vnd.pgrst.plan` with the query plan (`db-plan-enabled`). A plan reveals the shape of the database: keep it off in production. Default off |
| `requestSettings` | expose `request.method` / `path` / `headers` / `cookies` to SQL. Default on. The in-process operations set none of them: there is no request |
| `openApi` | serve the Swagger 2.0 document at `/`. Default on |
| `serverUrl` | the public URL used as `host` in the OpenAPI document. Defaults to the request's origin |

## What you get back

**`createRest`** (`@tsql/rest`):

| | |
| --- | --- |
| `handle(request, ctx?)` | the HTTP entry point. An explicit `ctx` overrides `resolveContext` |
| `schemaCache()` | the introspected catalog |
| `reloadSchema()` | re-read it after a migration. A failed reload keeps the previous cache |
| `close()` | stop the handler. Your driver is left open |

**`createQuery`** (`@tsql/query`):

| | |
| --- | --- |
| `select(input, ctx?)`, `insert`, `upsert`, `update`, `delete`, `rpc` | a request from an object, in-process: `{ data, count, error }`. Never reject → [`query.md`](query.md) |
| `setContextQuery(source)` | the operations with the context decided once, read per call — an `AsyncLocalStorage`, for instance → [`query.md`](query.md#binding-it-once) |
| `transaction(fn, ctx?)` | several queries in one transaction, the context applied once for all of it → [`query.md`](query.md#transactions) |
| `close()` | stop the instance. Your driver is left open |

`createQuery` takes the schema as an option, `schema`, generated at build time by `@tsql/query/types` → [`types.md`](types.md).
It never reads the catalog, so there is nothing to reload: after a migration, generate the module again. It is the one
place `createQuery` differs from `createRest`, which reads the catalog itself and has `schemaCache()` and
`reloadSchema()`.

With a generated database type — `createQuery<Database>(options)` — the operations are typed by it and everything else is
unchanged.

`handle` is for requests that come from outside: mount it in any server that speaks web-standard `Request`/`Response`.
In the same process, reach for the operations instead — a PostgREST client library over `handle` would build a URL and a
body for pg-rest to parse straight back, two passes over a query you are already holding as an object. Both packages
are built on one core, so the database sees the same thing either way; only the envelope differs. `@tsql/rest` stays
PostgREST's, to the byte; what goes beyond PostgREST (the `$` filters, computed updates) is in `@tsql/query` only.

An app that uses both creates both; after a migration it calls `reloadSchema()` on the handler and regenerates the
module for the query API:

```ts
const rest = await createRest({ db: nodePostgresAdapter(pool), schemas: ["api"] });
const db = createQuery<Database>({ db: nodePostgresAdapter(pool), schema });
```

## Errors

**`@tsql/rest`** throws errors that carry a PostgREST body (`code`, `message`, `details`, `hint`):

| | |
| --- | --- |
| `PgRestError` | thrown by the pure layers (parsers, SQL builders) with a status and a `PGRSTxxx` code |
| `DbQueryError` | a database failure, normalised from any driver by its SQLSTATE |
| `ApiError` | either of the above mapped to a status and a body. `handle()` turns it into a response |

`handle()` never rejects: a failure becomes a PostgREST-shaped JSON response.

**`@tsql/query`** has errors of its own, and none of the above: the operations never reject either, it returns a
`QueryError` — a `kind` to switch on, the `message`, `details` and `hint`, the `sqlState` of a database error, and the
input that produced it. See [`query.md`](query.md#errors).
