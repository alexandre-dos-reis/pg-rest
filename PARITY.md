# Parity with PostgREST v16

Legend: ✅ implemented and covered by tests · 🟡 partial / different (see notes) · ❌ not implemented · ➖ out of scope by design.

pg-rest is a **library**: the HTTP server, JWT and config-file layers of PostgREST are replaced by
`createPgRest(options)` and `resolveContext`. Everything below is about the request/response behaviour of `handle()`.

## Architecture & auth

| PostgREST | pg-rest | Notes |
| --- | --- | --- |
| Standalone server / CLI | ➖ | Use `Bun.serve({ fetch: (r) => api.handle(r) })` (or any web-standard host) |
| JWT validation, JWKS, `jwt-secret`, audience, role claim path | ➖ | Replaced by `resolveContext(req)` / `handle(req, ctx)` returning `{ role, claims, settings }` |
| `db-anon-role` | ✅ | `anonymousRole`; `PGRST302` when neither role nor anon role exists |
| `request.jwt.claims` GUC (always contains `role`) | ✅ | |
| `request.method/path/headers/cookies` GUCs | ✅ | `requestSettings` (default on) |
| `app.settings.*` / custom per-request GUCs | ✅ | `ctx.settings` (names must contain a dot) |
| `db-pre-request` | ✅ | `preRequest`: SQL function name or callback |
| `db-schemas` + `Accept-Profile` / `Content-Profile` | ✅ | `PGRST106` for unexposed schemas |
| `db-extra-search-path` | ✅ | `extraSearchPath` |
| `db-max-rows` | ✅ | `maxRows` |
| `db-tx-end` (rollback) / `Prefer: tx=` | ✅ | Off unless `allowTxOverride` |
| `openapi-mode`, `openapi-server-proxy-uri` | 🟡 | One mode; `serverUrl` option |
| `server-timing`, `log-level`, `server-host/port`, unix sockets | ➖ | Host concern |
| Connection pool tuning, `db-uri`, `db-channel` (NOTIFY reload), `SIGUSR1/2` | 🟡 | Bring your own pool via the adapter; reload with `reloadSchema()` (no LISTEN) |
| Admin server (`/live`, `/ready`, `/metrics`) | ➖ | |
| Automatic schema cache reload with retry on connection loss | 🟡 | Manual `reloadSchema()`; old cache is kept if a reload fails; DB outages → `503 PGRST001` |
| Database driver | 🟡 | Driver-agnostic `DbAdapter`; only a Bun.sql adapter ships |

## Reading

| Feature | Status | Notes |
| --- | --- | --- |
| `select` columns, `*`, aliases, `::cast`, JSON `->`/`->>` paths | ✅ | Casts limited to a strict type allowlist |
| Horizontal filtering: `eq neq gt gte lt lte like ilike match imatch in is isdistinct cs cd ov sl sr nxl nxr adj` | ✅ | |
| `not.` negation, `and()` / `or()` (nested) | ✅ | |
| `any` / `all` quantifiers | ✅ | |
| Full-text search `fts plfts phfts wfts` with language | ✅ | |
| `order` (asc/desc, nulls first/last, JSON paths) | ✅ | |
| `order` by related column (`order=rel(col)`) | ❌ | `PGRST127` |
| `limit`, `offset`, `Range` / `Range-Unit` headers | ✅ | `206` / `416` |
| `Prefer: count=exact` | ✅ | `Content-Range` |
| `count=planned` / `estimated` | ✅ | Via `EXPLAIN` |
| Aggregate functions (`count() sum() avg() min() max()`) with implicit `GROUP BY` | ✅ | |
| Aggregates combined with embeds / inside embeds | ❌ | `PGRST127` |
| Views | ✅ | Read/write per `pg_relation_is_updatable` |
| Materialized views, foreign tables, partitioned tables | 🟡 | Introspected as relations; not specifically tested |
| `Accept: application/json`, `text/csv`, `application/vnd.pgrst.object+json` (+ `nulls=stripped`) | ✅ | Singular → `PGRST116` |
| `application/vnd.pgrst.plan` (EXPLAIN output) | ❌ | |
| `application/geo+json`, `octet-stream`, `text/plain`, custom media type handlers | ❌ | |
| `Prefer: handling=strict/lenient` | ✅ | |
| `Prefer: timezone=` | ✅ | |
| Response `Preference-Applied`, `Vary`, `Location` | ✅ | |

## Resource embedding

| Feature | Status | Notes |
| --- | --- | --- |
| Many-to-one, one-to-many, one-to-one | ✅ | |
| Many-to-many through a junction table | ✅ | |
| Nested embeds, aliases | ✅ | |
| Hints `rel!fk_name`, `!column`, `!junction` | ✅ | Ambiguity → `PGRST201`, like PostgREST (incl. self-references) |
| `!inner` / `!left` | ✅ | |
| Filters, `order`, `limit`, `offset` on embeds (`embed.col=…`) | ✅ | |
| `embed=is.null` / `not.is.null` presence filters | ✅ | |
| Spread `...rel(col)` of to-one | ✅ | |
| Spread of to-many | ❌ | `PGRST127` |
| Embedding through a view's underlying foreign keys | ❌ | Views are not linked to the base-table FKs |
| Computed / function-based relationships | ❌ | |
| Embedding on RPC results returning a table type | ✅ | |
| Embedded `count` / spread aggregates | ❌ | |

## Writing

| Feature | Status | Notes |
| --- | --- | --- |
| `POST` single + bulk insert (JSON) | ✅ | |
| `POST` CSV / `application/x-www-form-urlencoded` bodies | ✅ | |
| `columns=` | ✅ | `PGRST204` for unknown columns |
| `Prefer: missing=default` | ✅ | |
| `Prefer: return=minimal/headers-only/representation` | ✅ | `Location` header on insert |
| Upsert: `resolution=merge-duplicates / ignore-duplicates`, `on_conflict` | ✅ | |
| `PUT` single-row upsert | ✅ | `PGRST114` / `PGRST115` checks |
| `PATCH` with filters | ✅ | Empty body handled |
| `DELETE` with filters | ✅ | |
| `limit`/`offset`/`order` on `PATCH`/`DELETE` | 🟡 | Limited-write validation is not fully ported |
| `Prefer: max-affected` (`PGRST124`) | ✅ | |
| Write response `select`, embeds and filters | ✅ | |
| Write through updatable views | ✅ | |
| `Prefer: params=single-object` | ❌ | Removed |

## Functions (RPC)

| Feature | Status | Notes |
| --- | --- | --- |
| `POST /rpc/fn` with JSON body, `GET` with query string args | ✅ | Typed from the function signature |
| Default arguments | ✅ | |
| Return shapes: scalar, composite, `SETOF`, `RETURNS TABLE`, `void` (204) | ✅ | |
| Filtering, `select`, `order`, paging, `count` on set results | ✅ | |
| Single unnamed `json`/`jsonb` parameter takes the whole body | ✅ | |
| Overloads, `PGRST202` / `PGRST203` | ✅ | |
| `GET` only for non-volatile functions (read-only transaction) | ✅ | |
| `VARIADIC` parameters | ❌ | |
| Bulk call (array body) | ❌ | |
| `response.headers` / `response.status` GUCs set by the function | ✅ | |
| `Prefer: max-affected` on RPC | ✅ | `PGRST128` for non-set functions |
| Scalar-function custom media types (`text/plain`, `application/octet-stream`, …) | ❌ | |

## Errors

| Feature | Status | Notes |
| --- | --- | --- |
| PostgREST error body `{code, message, details, hint}` | ✅ | |
| `PGRST1xx`–`PGRST3xx` codes (parsing, schema cache, auth) | ✅ | Most; `PGRST3xx` JWT codes are replaced by whatever `resolveContext` throws |
| SQLSTATE → HTTP status table | ✅ | |
| `RAISE ... SQLSTATE 'PTxyz'` → HTTP status | ✅ | |
| `RAISE ... SQLSTATE 'PGRST'` with JSON message / detail | ✅ | |
| `WWW-Authenticate` header on 401 | ❌ | Add it yourself in `resolveContext`'s `PgRestError` headers |
| Serialization failure retry | ✅ | Up to 2 retries on `40001` |

## Other

| Feature | Status | Notes |
| --- | --- | --- |
| OpenAPI (Swagger 2.0) at `/` | 🟡 | Tables, views, RPC, parameters, definitions; no security definitions, may differ in detail from PostgREST |
| `OPTIONS` / CORS | 🟡 | `OPTIONS` handled with `Allow`; CORS headers are the host's responsibility |
| Schema cache from `pg_catalog` | ✅ | Tables, views, columns, PK/UK/FK, functions, comments |
| Domain types, enums, range/array/composite types | 🟡 | Passed through as Postgres returns them; only common types tested |
| Hot-reloading on DDL | ❌ | Call `reloadSchema()` after migrations |

## Verification status

Behaviour is checked against a real PostgreSQL 16 (177 tests: schema, parsing, reads, writes, RPC, request context, security).
There is **no differential test against a running PostgREST**; parity is based on the PostgREST v16 documentation, changelog
and error tables, so edge cases may still differ. Reports of differences are welcome.
