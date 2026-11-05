# `createPgRest(options)`

```ts
const pgRest = await createPgRest({
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

| option | meaning |
| --- | --- |
| `db` | a `DbAdapter` built from your driver → [`adapters.md`](adapters.md) |
| `schemas` | the exposed schemas; the first is the default, the others are selected with `Accept-Profile` / `Content-Profile` or `schema:` in a query. Default `["public"]` |
| `anonymousRole` | the role for a call with no context. Default `"anon"`; `false` refuses anonymous calls with `401 PGRST302` |
| `resolveContext(req)` | who is calling: return `{ role, claims, settings }`, or `undefined` for the anonymous role. Throw a `PgRestError` to reject outright. There is no JWT — use a cookie, an API key, your auth library |
| `maxRows` | a cap on the rows a read returns (PostgREST's `db-max-rows`) |
| `basePath` | a URL prefix to strip, so the handler can be mounted anywhere (`/api/rest`) |
| `extraSearchPath` | schemas appended to `search_path` after the selected one. Default `["public"]` |
| `requestSettings` | expose `request.method` / `path` / `headers` / `cookies` to SQL. Default on |
| `preRequest` | a SQL function name (`"auth.check"`) or a callback `(session, info) => Promise<void>`, run inside the request's transaction (`db-pre-request`) |
| `allowTxOverride` | honour `Prefer: tx=rollback` (`db-tx-end`). Default off |
| `planEnabled` | answer `Accept: application/vnd.pgrst.plan` with the query plan (`db-plan-enabled`). A plan reveals the shape of the database: keep it off in production. Default off |
| `openApi` | serve the Swagger 2.0 document at `/`. Default on |
| `serverUrl` | the public URL used as `host` in the OpenAPI document. Defaults to the request's origin |

## What you get back

| | |
| --- | --- |
| `handle(request, ctx?)` | the HTTP entry point. An explicit `ctx` overrides `resolveContext` |
| `query(input, ctx?)` | the same thing from an object, in-process. Throws a `QueryError` → [`query.md`](query.md) |
| `querySafe(input, ctx?)` | `query` with the failure as a value: `{ data, error }`. Never rejects |
| `generateTypes(options?)` | TypeScript types for this database, as the text of a module → [`types.md`](types.md) |
| `schemaCache()` | the introspected catalog |
| `reloadSchema()` | re-read it after a migration. A failed reload keeps the previous cache |
| `close()` | stop the handler. Your driver is left open |

With a generated database type — `createPgRest<Database>(options)` — `query` and `querySafe` are typed by it and
everything else is unchanged.

`handle` is a plain `fetch`, which is all a PostgREST client library needs: hand it one and the exchange never touches a
socket.

```ts ignore
const client = new PostgrestClient("http://pg-rest", {
  fetch: (input, init) => pgRest.handle(new Request(input, init), ctx),
});
```

## Errors

Everything the library throws carries a PostgREST body (`code`, `message`, `details`, `hint`):

| | |
| --- | --- |
| `PgRestError` | thrown by the pure layers (parsers, SQL builders) with a status and a `PGRSTxxx` code |
| `DbQueryError` | a database failure, normalised from any driver by its SQLSTATE |
| `ApiError` | either of the above mapped to a status and a body. `handle()` turns it into a response |
| `QueryError` | an `ApiError` from `query()`, plus the input that produced it |

`handle()` never rejects: a failure becomes a PostgREST-shaped JSON response. `querySafe()` never rejects either: it
returns the error. See [`query.md`](query.md#errors) for the codes you are likely to meet.
