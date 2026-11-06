# Design

pg-rest is PostgREST's request behaviour as a **library**. Everything PostgREST does *around* that behaviour — running a
process, validating a JWT, reading a config file — is left to the application, on purpose.

- [What it does](#what-it-does)
- [What it will never do](#what-it-will-never-do)
- [What being a library adds](#what-being-a-library-adds)
- [What is simply not done yet](#what-is-simply-not-done-yet)

## What it does

Reads with embedding (m2o, o2m, o2o, m2m, aliases, hints, `!inner`, spread of to-one and to-many, nested, filters,
order and paging on embeds, embedding through views and computed relationships, aggregates in embeds, order by a related
column), all filter operators and `and`/`or`/`not`, JSON paths, casts, aggregates, ordering,
`Range`/`limit`/`offset`, `Prefer: count=exact|planned|estimated`, inserts (bulk, `columns`, `missing=default`),
upsert, `PATCH`, `PUT`, `DELETE`, `return=` / `handling=` / `max-affected` / `timezone` / `tx`, RPC (GET and POST,
overloads, `VARIADIC`, bulk calls, set/scalar/void, unnamed JSON argument, response GUC headers and status), CSV,
singular and `nulls=stripped` representations, plan output, custom media type handlers (domains and aggregates named
after a media type), `application/geo+json` with PostGIS, `WWW-Authenticate` on 401, OpenAPI, and PostgREST's error
codes with the `PTxyz` and `RAISE … SQLSTATE 'PGRST'` conventions.

Feature by feature, with what differs: [`PARITY.md`](../PARITY.md).

## What it will never do

Not gaps — adding them would work against the point of the project.

| PostgREST feature | why not | what to do instead |
| --- | --- | --- |
| JWT validation, JWKS, `jwt-secret`, audience, role claim path | The point is that **you** decide who the caller is, by any means: a session cookie, an API key, Better Auth, mTLS. Baking in JWT would force one scheme and add crypto and key rotation — and dependencies — to the library | `resolveContext(req)`, or `handle(req, ctx)`, returns `{ role, claims, settings }`. pg-rest applies it with `set_config`, so RLS and `current_setting('request.jwt.claims')` work as usual. See [`examples/with-better-auth`](../examples/with-better-auth) |
| Standalone server, CLI, host/port, unix sockets, TLS, `log-level`, `server-timing` | `handle(Request) => Response` is web-standard and runs under `Bun.serve`, `@hono/node-server`, or anything that hands you a `Request`. Owning the server would tie the library to one runtime and duplicate what your framework already does | Mount `handle` in your own server |
| Admin server (`/live`, `/ready`, `/metrics`) | Health checks and metrics belong to the host process | Expose them in your app |
| CORS headers | Policy depends on your deployment | Set them in your server or middleware |
| Config file, environment variables, `PGRST_*` | Configuration is the `createPgRest(options)` call: typed, and living with the code | Pass options; read env vars yourself |
| Connection pool, `db-uri` | The pool belongs to your driver, and the driver is your choice. pg-rest never opens a connection | Create the pool, wrap it in an adapter |
| In-database configuration (`db-pre-config`, per-role `ALTER ROLE … SET pgrst.*`) | Settings are options in code, so they are versioned and visible with the application | Use the options; `preRequest` can still call a SQL function for database-side logic |
| Schema cache reload over SQL (`NOTIFY pgrst`, `db-channel`, `SIGUSR1`/`SIGUSR2`, DDL event triggers) | They need a dedicated `LISTEN` connection and signal handling, which a library must not hold open or assume — serverless, PGlite and pooled connections cannot `LISTEN`. The introspection itself is implemented | Call `reloadSchema()` after a migration, or wire it to your own `LISTEN` |

## What being a library adds

The same trade reversed: because it runs inside your process, it can do things a server cannot.

- **Queries without HTTP.** `query({ table: "todos", select: ["id"] })` goes through the same parser, the same SQL and
  the same errors as a request — no loopback call, and no second copy of the logic for your server components, jobs and
  webhooks. → [`query.md`](query.md)
- **Types from your own catalog.** `generateTypes()` reads the cache the library already holds, so the types describe
  exactly what it accepts. → [`types.md`](types.md)
- **Composite values as objects.** `where: { owner: { city: "Paris" } }` compares a
  [composite column](https://www.postgresql.org/docs/current/rowtypes.html) against a row of its own type, where
  PostgREST can only answer `0A000`: the query string has no way to say what type its literal is, and an object does.
  The one deliberate departure from parity, marked ➕ in [`PARITY.md`](../PARITY.md). → [`query.md`](query.md#composite-types)
- **Your auth, not a scheme.** `resolveContext` is a function, so "who is the caller" can be anything your application
  already knows.
- **One process, one pool.** Your app and the REST layer share a driver, a transaction discipline and a deployment.

Both entry points converge on one pipeline on purpose; what that looks like is in [`architecture.md`](architecture.md).

## What is simply not done yet

Additions being weighed rather than planned — a transaction across several `query()` calls, observability hooks,
guardrails for an exposed surface, a debug mode — are written out, with their cost, in
[`proposals.md`](proposals.md).

A handful of things are missing rather than refused — `PATCH`/`PUT` on a function's result, a few representation and
header details. [`PARITY.md`](../PARITY.md) marks them ❌, as opposed to ➖ for the list above, and the differential test
against the real PostgREST 16 binary is what keeps that table honest.
