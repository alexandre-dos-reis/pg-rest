# pg-rest

A [PostgREST](https://postgrest.org) (v16 behaviour) reimplementation for **Bun**, shipped as a **library**:
a web-standard `handle(Request) => Promise<Response>` on top of a driver-agnostic database adapter.

There is **no JWT handling and no server**. You decide who the caller is (cookie, API key, session, mTLS…)
and hand pg-rest a role, claims and settings; they are applied per request with `set_config`, so
Postgres Row Level Security sees them exactly as it would behind PostgREST.

```ts
import { createPgRest } from "pg-rest";

const api = await createPgRest({
  db: process.env.DATABASE_URL!,          // connection string (Bun.sql) or a DbAdapter
  schemas: ["api"],                       // first one is the default schema
  anonymousRole: "anon",
  resolveContext: async (req) => {
    const user = await mySessionLookup(req);
    return user ? { role: "authenticated", claims: { sub: user.id, email: user.email } } : undefined;
  },
});

Bun.serve({ fetch: (req) => api.handle(req) });
```

In SQL, policies read the same GUCs as with PostgREST:

```sql
CREATE POLICY own ON api.notes USING (owner = (current_setting('request.jwt.claims', true)::json ->> 'sub'));
```

## Options

| option | meaning |
| --- | --- |
| `db` | connection string, `Bun.SQL` client or any `DbAdapter` (`query`, `transaction`, optional `close`) |
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
```
