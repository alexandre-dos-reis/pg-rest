# pg-rest

A [PostgREST](https://postgrest.org) (v16 behaviour) reimplementation as a **library**: a web-standard
`handle(Request) => Promise<Response>` on top of a tiny database-adapter interface.

- **Runtime-agnostic.** The core uses only web standards (`Request`/`Response`/`Headers`) and has no driver and no runtime API
  of its own. It is tested on Bun and Node.js 22 and should run anywhere your Postgres driver does.
- **Bring your own driver.** You create the driver and pass it in through a small adapter. Adapters for
  Bun.sql, node-postgres, postgres.js and PGlite ship as separate entry points (`pg-rest/adapters/*`); the drivers are
  *optional peer dependencies*, so you only install the one you use.
- **No JWT and no server.** You decide who the caller is (cookie, API key, session, mTLS…) and hand pg-rest a role, claims and
  settings; they are applied per request with `set_config`, so Postgres Row Level Security sees them exactly as it would behind PostgREST.

## Quick start

```sh
npm i pg-rest pg         # or: bun add pg-rest (Bun.sql is built in), postgres, @electric-sql/pglite
```

```ts
import pg from "pg";
import { createPgRest } from "pg-rest";
import { nodePostgresAdapter } from "pg-rest/adapters/node-postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const pgRest = await createPgRest({
  db: nodePostgresAdapter(pool),           // you create and close the driver
  schemas: ["api"],                        // first one is the default schema
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

| example | runtime | driver | needs a database server |
| --- | --- | --- | --- |
| [`with-bun`](examples/with-bun) | Bun | `Bun.sql` (built in) | yes (docker-compose included) |
| [`with-node-postgres`](examples/with-node-postgres) | Node.js ≥ 22.18 | `pg` | yes (docker-compose included) |
| [`with-postgres-js`](examples/with-postgres-js) | Node.js ≥ 22.18 | `postgres` | yes (docker-compose included) |
| [`with-pglite`](examples/with-pglite) | Node.js ≥ 22.18 | `@electric-sql/pglite` | no (Postgres in WebAssembly) |

## Database adapters

`db` is a `DbAdapter` — the only thing pg-rest needs from a driver:

```ts
interface DbAdapter {
  query(text: string, params?: (string | null)[]): Promise<Record<string, unknown>[]>;
  transaction<A>(fn: (session: { query: DbAdapter["query"] }) => Promise<A>): Promise<A>; // one connection, BEGIN/COMMIT/ROLLBACK
  close?(): Promise<void>;
}
```

| import | wraps | peer dependency |
| --- | --- | --- |
| `pg-rest/adapters/bun` → `bunSqlAdapter(sql)` | `new SQL(url)` from `"bun"` | none (built into Bun) |
| `pg-rest/adapters/node-postgres` → `nodePostgresAdapter(pool)` | `new pg.Pool(...)` | `pg` ≥ 8 |
| `pg-rest/adapters/postgres-js` → `postgresJsAdapter(sql)` | `postgres(url)` | `postgres` ≥ 3 |
| `pg-rest/adapters/pglite` → `pgliteAdapter(db)` | `new PGlite()` | `@electric-sql/pglite` |

The adapters are structural (they never import the driver; you pass the client in), so a project only loads the code it imports.
To support another driver, implement the interface above (about 20 lines) — the adapter sources in `src/adapters` are good templates.

Parameters are always text with an explicit `$n::text` cast in the SQL, so no type inference is needed. Database errors are recognised
by SQLSTATE (`code`, `errno` or `sqlState` on the thrown error), so adapters don't have to translate them. pg-rest never closes your
driver; `pgRest.close()` only stops the handler.

In SQL, policies read the same GUCs as with PostgREST:

```sql
CREATE POLICY own ON api.notes USING (owner = (current_setting('request.jwt.claims', true)::json ->> 'sub'));
```

## Options

| option | meaning |
| --- | --- |
| `db` | a `DbAdapter` built from your driver (see [Database adapters](#database-adapters)) |
| `schemas` | exposed schemas; selected with `Accept-Profile` / `Content-Profile` |
| `anonymousRole` | role when no context is resolved (`PGRST302` if unset and none given) |
| `resolveContext(req)` | return `{ role, claims, settings }`; throw `PgRestError` to reject (e.g. 401) |
| `handle(req, ctx?)` | an explicit context overrides `resolveContext` |
| `maxRows` | cap on rows returned |
| `basePath` | URL prefix to strip |
| `extraSearchPath` | extra schemas appended to `search_path` |
| `requestSettings` | set `request.method/path/headers/cookies` GUCs (default on) |
| `preRequest` | SQL function name or `(session, info) => void`, run inside the request transaction |
| `allowTxOverride` | honour `Prefer: tx=rollback` |
| `openApi` | serve the Swagger 2.0 document at `/` |

Also returned: `reloadSchema()` (call after migrations), `schemaCache()`, `close()`.

## Supported

Reads with embedding (m2o, o2m, o2o, m2m, aliases, hints, `!inner`, spread of to-one, nested, filters/order/limit on embeds),
all filter operators and `and/or/not`, JSON paths, casts, aggregates, ordering, `Range`/`limit`/`offset`,
`Prefer: count=exact|planned|estimated`, inserts (bulk, `columns`, `missing=default`), upsert, PATCH, PUT, DELETE,
`return=` / `handling=` / `max-affected` / `timezone` / `tx`, RPC (GET/POST, overloads, set/scalar/void, unnamed json arg,
response GUC headers/status), CSV / singular / `nulls=stripped` representations, OpenAPI, PostgREST error codes
and `PTxyz` / `RAISE ... SQLSTATE 'PGRST'` conventions.

## Not supported (yet)

- Ordering by a related table column, spreading to-many, aggregates inside embeds → `PGRST127`
- Embedding through the foreign keys of views, computed relationships, `VARIADIC` functions
- JWT, JWKS, config files, LISTEN-based reload, the standalone server (by design)
- `params=single-object`

## Security notes

Request values are never concatenated raw: values become escaped literals or `$n::text` parameters, identifiers are quoted,
cast targets must match a strict type allowlist, GUC names must be dotted. See `tests/security.test.ts`.

## Development

```sh
bun install
TEST_DATABASE_URL=postgres://user@host:5432/postgres bun test   # needs a Postgres 16 you can create databases on
bun run typecheck
bun run build

# differential test against a real PostgREST 16 binary (see PARITY.md)
POSTGREST_BIN=/path/to/postgrest TEST_DATABASE_URL=... bun run test:compare

# run an example end to end (build first); the second argument is a database URL with the schema loaded
bun run build && scripts/check-example.sh with-node-postgres postgres://user@host:5432/mydb
```
