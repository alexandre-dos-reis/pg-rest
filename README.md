# pg-rest

A [PostgREST](https://postgrest.org) (v16 behaviour) reimplementation as a **library**: a web-standard
`handle(Request) => Promise<Response>` on top of a tiny database-adapter interface.

- **Runtime-agnostic.** The core uses only web standards (`Request`/`Response`/`Headers`) and has no driver and no runtime API
  of its own. It is tested on Bun and Node.js 22 and should run anywhere your Postgres driver does.
- **Bring your own driver.** You create the driver and pass it in through a small adapter. Adapters for
  Bun.sql, node-postgres, postgres.js and PGlite ship as separate entry points (`pg-rest/adapters/*`); the drivers are
  _optional peer dependencies_, so you only install the one you use.
- **No JWT and no server.** You decide who the caller is (cookie, API key, session, mTLS…) and hand pg-rest a role, claims and
  settings; they are applied per request with `set_config`, so Postgres Row Level Security sees them exactly as it would behind PostgREST.

## Quick start

```sh
npm i @adrdp/pg-rest pg         # or: bun add @adrdp/pg-rest (Bun.sql is built in), postgres, @electric-sql/pglite
```

```ts
import pg from "pg";
import { createPgRest } from "pg-rest";
import { nodePostgresAdapter } from "pg-rest/adapters/node-postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const pgRest = await createPgRest({
  db: nodePostgresAdapter(pool), // you create and close the driver
  schemas: ["api"], // first one is the default schema
  anonymousRole: "anon",
  resolveContext: async (req) => {
    const user = await mySessionLookup(req);
    return user ? { role: "authenticated", claims: { sub: user.id, email: user.email } } : undefined;
  },
});

// any host that speaks Request/Response:
//   Bun:     Bun.serve({ fetch: (req) => pgRest.handle(req) })
//   Node:    serve({ fetch: (req) => pgRest.handle(req) })      // @hono/node-server (or srvx, ...)
//   Hono:    app.all("/api/*", (c) => pgRest.handle(c.req.raw))
```

## Examples

Self-contained projects in [`examples/`](examples) (a todo API with Row Level Security; each has its own README, schema and `server.ts`):

| example                                             | runtime         | driver                                                 | needs a database server       |
| --------------------------------------------------- | --------------- | ------------------------------------------------------ | ----------------------------- |
| [`with-bun`](examples/with-bun)                     | Bun             | `Bun.sql` (built in)                                   | yes (docker-compose included) |
| [`with-node-postgres`](examples/with-node-postgres) | Node.js ≥ 22.18 | `pg`                                                   | yes (docker-compose included) |
| [`with-postgres-js`](examples/with-postgres-js)     | Node.js ≥ 22.18 | `postgres`                                             | yes (docker-compose included) |
| [`with-pglite`](examples/with-pglite)               | Node.js ≥ 22.18 | `@electric-sql/pglite`                                 | no (Postgres in WebAssembly)  |
| [`with-better-auth`](examples/with-better-auth)     | Node.js ≥ 22.18 | `pg` + [Better Auth](https://better-auth.com) sessions | yes (docker-compose included) |

## Database adapters

`db` is a `DbAdapter` — the only thing pg-rest needs from a driver:

```ts
interface DbAdapter {
  query(text: string, params?: (string | null)[]): Promise<Record<string, unknown>[]>;
  transaction<A>(fn: (session: { query: DbAdapter["query"] }) => Promise<A>): Promise<A>; // one connection, BEGIN/COMMIT/ROLLBACK
  close?(): Promise<void>;
}
```

| import                                                         | wraps                       | peer dependency        |
| -------------------------------------------------------------- | --------------------------- | ---------------------- |
| `pg-rest/adapters/bun` → `bunSqlAdapter(sql)`                  | `new SQL(url)` from `"bun"` | none (built into Bun)  |
| `pg-rest/adapters/node-postgres` → `nodePostgresAdapter(pool)` | `new pg.Pool(...)`          | `pg` ≥ 8               |
| `pg-rest/adapters/postgres-js` → `postgresJsAdapter(sql)`      | `postgres(url)`             | `postgres` ≥ 3         |
| `pg-rest/adapters/pglite` → `pgliteAdapter(db)`                | `new PGlite()`              | `@electric-sql/pglite` |

The adapters are structural (they never import the driver; you pass the client in), so a project only loads the code it imports.
To support another driver, implement the interface above (about 20 lines) — the adapter sources in `src/adapters` are good templates.

Parameters are always text with an explicit `$n::text` cast in the SQL, so no type inference is needed. Database errors are recognised
by SQLSTATE (`code`, `errno` or `sqlState` on the thrown error), so adapters don't have to translate them. pg-rest never closes your
driver; `pgRest.close()` only stops the handler.

In SQL, policies read the same GUCs as with PostgREST:

```sql
CREATE POLICY own ON api.notes USING (owner = (current_setting('request.jwt.claims', true)::json ->> 'sub'));
```

## Performance

[`bench/`](bench) load-tests pg-rest against the real PostgREST 16 on the same database, data and pool size, after checking that both return identical
results. In a small 2-vCPU sandbox pg-rest on Bun was on par with or faster than PostgREST in every scenario, and slower on a few of the cheapest ones
when run on Node (it also uses more memory); the benchmark includes `bun build --compile`, `--bytecode` and `bun compile` variants; see [`bench/README.md`](bench/README.md) for the numbers, the caveats and how to run it on your own hardware.

### Which runtime?

Numbers from one run on a small 2-vCPU sandbox (indicative only; see the benchmark README). Throughput is relative to PostgREST 16.

|              | Bun (`bun run`)                       | Bun, compiled (`bun compile`, experimental)                              | Node + `pg`                                             |
| ------------ | ------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| Throughput   | 1.2–1.5× on most reads, ~2× on writes | same as plain Bun (within noise)                                         | 0.7–0.9× on the cheapest queries, ahead on heavier ones |
| Peak memory  | ~80 MB                                | ~50 MB                                                                   | ~125 MB                                                 |
| Setup        | nothing extra                         | single executable; needs a recent (canary) Bun                           | Node (tested on 22)                                     |
| Pick it when | you can run Bun (default choice)      | memory or deployment size matters and you accept an experimental feature | Bun is not an option                                    |

`bun build --compile` and `--bytecode` performed like plain Bun, so they are only worth it if you want a single binary. PostgREST itself uses the least memory (about 40–47 MB).

## Options

| option                | meaning                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `db`                  | a `DbAdapter` built from your driver (see [Database adapters](#database-adapters))                        |
| `schemas`             | exposed schemas; selected with `Accept-Profile` / `Content-Profile`                                       |
| `anonymousRole`       | role when no context is resolved (`PGRST302` if unset and none given); `false` refuses anonymous requests |
| `planEnabled`         | allow `Accept: application/vnd.pgrst.plan` (EXPLAIN output); off by default, like `db-plan-enabled`       |
| `resolveContext(req)` | return `{ role, claims, settings }`; throw `PgRestError` to reject (e.g. 401)                             |
| `handle(req, ctx?)`   | an explicit context overrides `resolveContext`                                                            |
| `maxRows`             | cap on rows returned                                                                                      |
| `basePath`            | URL prefix to strip                                                                                       |
| `extraSearchPath`     | extra schemas appended to `search_path`                                                                   |
| `requestSettings`     | set `request.method/path/headers/cookies` GUCs (default on)                                               |
| `preRequest`          | SQL function name or `(session, info) => void`, run inside the request transaction                        |
| `allowTxOverride`     | honour `Prefer: tx=rollback`                                                                              |
| `openApi`             | serve the Swagger 2.0 document at `/`                                                                     |

Also returned: `reloadSchema()` (call after migrations), `schemaCache()`, `close()`.

## Supported

Reads with embedding (m2o, o2m, o2o, m2m, aliases, hints, `!inner`, spread of to-one, nested, filters/order/limit on embeds),
all filter operators and `and/or/not`, JSON paths, casts, aggregates, ordering, `Range`/`limit`/`offset`,
spread of to-many, order by related column, embedding through views and computed relationships, aggregates in embeds,
`Prefer: count=exact|planned|estimated`, inserts (bulk, `columns`, `missing=default`), upsert, PATCH, PUT, DELETE,
`return=` / `handling=` / `max-affected` / `timezone` / `tx`, RPC (GET/POST, overloads, `VARIADIC`, bulk calls, set/scalar/void, unnamed json arg,
response GUC headers/status), CSV / singular / `nulls=stripped` / plan representations, custom media type handlers (domains and aggregates named after a media type), `application/geo+json` (with PostGIS), `WWW-Authenticate` on 401, OpenAPI, PostgREST error codes
and `PTxyz` / `RAISE ... SQLSTATE 'PGRST'` conventions.

## Not supported

Two different things are listed here. Don't confuse them.

### By design: will not be implemented

pg-rest is a library, not a server. Anything whose job is to run the process, authenticate the caller, or configure PostgREST from outside the
code is handled by _your_ application instead. These are not gaps: adding them would work against the goals of the project.

| PostgREST feature                                                                                                      | Why pg-rest doesn't do it                                                                                                                                                                                                                                   | What to do instead                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JWT validation, JWKS, `jwt-secret`, audience, role claim path                                                          | The point of the project is that **you** decide who the caller is, by any means: a session cookie, an API key, Better Auth, mTLS. Baking JWT in would force one scheme and add crypto and key-rotation code (and dependencies) to the library.              | `resolveContext(req)` or `handle(req, ctx)` returns `{ role, claims, settings }`. pg-rest applies it with `set_config`, so RLS and `current_setting('request.jwt.claims')` work as usual. See `examples/with-better-auth`. |
| Standalone server, CLI, host/port, unix sockets, TLS, `log-level`, `server-timing`                                     | `handle(Request) => Response` is web-standard and runs under `Bun.serve`, Hono (`@hono/node-server`), or any framework that gives you a `Request`... Owning the server would tie the library to one runtime and duplicate what your framework already does. | Mount `handle` in your own server.                                                                                                                                                                                         |
| Admin server (`/live`, `/ready`, `/metrics`)                                                                           | Health checks and metrics belong to the host process.                                                                                                                                                                                                       | Expose them in your app.                                                                                                                                                                                                   |
| CORS headers                                                                                                           | Policy depends on your deployment.                                                                                                                                                                                                                          | Set them in your server or middleware.                                                                                                                                                                                     |
| Config file, environment variables, `PGRST_*` settings                                                                 | Configuration is the `createPgRest(options)` call, which is typed and lives with the code.                                                                                                                                                                  | Pass options; read env vars yourself.                                                                                                                                                                                      |
| Connection pool and `db-uri`                                                                                           | The pool belongs to your driver, and the driver is your choice (`DbAdapter`). pg-rest never opens connections.                                                                                                                                              | Create the pool, wrap it in an adapter.                                                                                                                                                                                    |
| In-database configuration (`db-pre-config`, per-role `ALTER ROLE ... SET pgrst.*`)                                     | Settings are options in code, not rows in the database, so they are versioned and visible with the application.                                                                                                                                             | Use the options; `preRequest` can still call a SQL function if you want database-side logic.                                                                                                                               |
| Schema cache refresh over SQL: `NOTIFY pgrst, 'reload schema'` / `db-channel`, `SIGUSR1`/`SIGUSR2`, DDL event triggers | They require a dedicated `LISTEN` connection and signal handling, which a library must not hold open or assume (serverless, PGlite and pooled connections can't `LISTEN`). The introspection itself (`pg_catalog`) is implemented.                          | Call `reloadSchema()` after migrations, or wire it to your own `LISTEN`. A failed reload keeps the old cache.                                                                                                              |

## Security notes

Request values are never concatenated raw: values become escaped literals or `$n::text` parameters, identifiers are quoted,
cast targets must match a strict type allowlist, GUC names must be dotted. See `tests/security.test.ts`.

## Development

`mise.toml` pins the PostgREST binary the differential test needs and runs a throwaway Postgres 16 **with PostGIS**
(required: the `application/geo+json` cases fail without it). Nothing is installed system-wide.

```sh
bun install
mise install        # PostgREST 16.5, the official static release
mise run db:start   # Postgres 16 + PostGIS under .cache/ (also db:stop, db:reset)
mise run test       # the whole suite, differential and GeoJSON cases included
```

Or bring your own Postgres 16 and PostgREST:

```sh
TEST_DATABASE_URL=postgres://user@host:5432/postgres bun test   # a server you can create databases on
POSTGREST_BIN=/path/to/postgrest TEST_DATABASE_URL=... bun run test:compare   # see PARITY.md
bun run typecheck && bun run build

# run an example end to end; the second argument is a database URL with the schema loaded
scripts/check-example.sh with-node-postgres postgres://user@host:5432/mydb
```

The examples depend on `pg-rest` by version, so use `bun run link:examples [name]` to point them at the local
build; `bun run check:examples` asserts they match the root `package.json`.
