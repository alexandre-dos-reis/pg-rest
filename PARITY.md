# Parity with PostgREST v16

Legend: ✅ implemented and covered by tests · 🟡 partial / different (see notes) · ❌ not implemented · ➖ out of scope **by design** (it is a library: the host app owns it, see [`docs/design.md`](docs/design.md)), as opposed to ❌, which is simply not done yet · ➕ **more** than PostgREST: it answers an error where pg-rest answers, deliberately (the note says what and why).

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
| Connection pool tuning, `db-uri` | ➖ | Bring your own pool via the adapter |
| `db-channel` (NOTIFY reload), `SIGUSR1/2`, `db-pre-config` | ➖ | Reload with `reloadSchema()`, or wire your own `LISTEN` to it; options replace in-database config |
| Admin server (`/live`, `/ready`, `/metrics`) | ➖ | |
| Automatic schema cache reload with retry on connection loss | 🟡 | Manual `reloadSchema()`; old cache is kept if a reload fails; DB outages → `503 PGRST001` |
| Database driver | 🟡 | Driver-agnostic `DbAdapter`; adapters for Bun.sql, node-postgres, postgres.js and PGlite ship as `pg-rest/adapters/*` (drivers are optional peer dependencies; the core contains none). Verified on Bun (full suite) and Node 22 (smoke test); each adapter is exercised by an example in CI |

## Reading

| Feature | Status | Notes |
| --- | --- | --- |
| `select` columns (`columns` in `@tsql/query`), `*`, aliases, `::cast`, JSON `->`/`->>` paths | ✅ | Casts limited to a strict type allowlist. A path on anything other than `json`/`jsonb` -- a composite type, an array, a scalar, or a column whose type is unknown -- goes through `to_jsonb()` first, as PostgREST does; a path ending on an index is named after the last key before it |
| Horizontal filtering: `eq neq gt gte lt lte like ilike match imatch in is isdistinct cs cd ov sl sr nxl nxr adj` | ✅ | |
| `not.` negation, `and()` / `or()` (nested) | ✅ | |
| `any` / `all` quantifiers | ✅ | |
| Full-text search `fts plfts phfts wfts` with language | ✅ | |
| `order` (asc/desc, nulls first/last, JSON paths) | ✅ | |
| `order` by related column (`order=rel(col)`) | ✅ | To-one relationships, including computed ones |
| `limit`, `offset`, `Range` / `Range-Unit` headers | ✅ | `206` / `416` |
| `Prefer: count=exact` | ✅ | `Content-Range` |
| `count=planned` / `estimated` | ✅ | Via `EXPLAIN` |
| Aggregate functions (`count() sum() avg() min() max()`) with implicit `GROUP BY` | ✅ | Always on; PostgREST needs `db-aggregates-enabled` |
| Aggregates combined with embeds / inside embeds | ✅ | |
| Views | ✅ | Read/write per `pg_relation_is_updatable` |
| Materialized views, foreign tables, partitioned tables | 🟡 | Introspected as relations; not specifically tested |
| Non-numeric `limit`/`offset` ignored, negative `limit` → `PGRST103`, unsupported methods → empty 405 | ✅ | |
| `Accept: application/json`, `text/csv`, `application/vnd.pgrst.object+json` (+ `nulls=stripped`) | ✅ | Singular → `PGRST116` |
| `application/vnd.pgrst.plan` (EXPLAIN output) | ✅ | `for=` and `options=`; off unless `planEnabled` (like `db-plan-enabled`) |
| Custom media type handlers: aggregates named after a media type (per table or `anyelement`, incl. the `*/*` catch-all) returning a domain | ✅ | `text/plain`, `text/xml`, `application/octet-stream`, … |
| `application/geo+json` | ✅ | `FeatureCollection` via PostGIS `ST_AsGeoJSON(record)`; needs PostGIS in your database. Compared against PostgREST on the same PostGIS, including a NULL geometry, which 3.4 renders `{"type": null}` and 3.6 renders `null` |
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
| Spread of to-many | ✅ | Per-column arrays; aggregates inside → `PGRST127` like PostgREST |
| Embedding through a view's underlying foreign keys | ✅ | Resolved from the view definition, view↔table and view↔view |
| Computed / function-based relationships | ✅ | |
| Embedding on RPC results returning a table type | ✅ | |
| Embedded `count` / spread aggregates | ✅ | |

## Writing

| Feature | Status | Notes |
| --- | --- | --- |
| `POST` single + bulk insert (JSON) | ✅ | |
| `POST` CSV / `application/x-www-form-urlencoded` bodies | ✅ | |
| `columns=` | ✅ | `PGRST204` for unknown columns |
| `Prefer: missing=default` | ✅ | |
| `Prefer: return=minimal/headers-only/representation` | ✅ | `Location` header on insert |
| Upsert: `resolution=merge-duplicates / ignore-duplicates`, `on_conflict` | ✅ | Status 200 when only existing rows were updated, else 201 |
| `PUT` single-row upsert | ✅ | `PGRST114` / `PGRST115` checks |
| `PATCH` with filters | ✅ | Empty body handled |
| `DELETE` with filters | ✅ | |
| `limit`/`offset`/`order` on `PATCH`/`DELETE` | ✅ | Ignored, as in PostgREST v16 (`PUT` with limit/offset → `PGRST114`) |
| `Prefer: max-affected` (`PGRST124`) | ✅ | |
| Write response `select`, embeds and filters | ✅ | `returning: [...]` in `@tsql/query` |
| Write through updatable views | ✅ | |
| `Prefer: params=single-object` | ➖ | Removed from PostgREST v16 itself |

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
| `VARIADIC` parameters | ✅ | |
| Bulk call (array body) | ✅ | `PGRST102` when the objects' keys differ |
| `response.headers` / `response.status` GUCs set by the function | ✅ | |
| `Prefer: max-affected` on RPC | ✅ | `PGRST128` for non-set functions |
| Scalar-function custom media types (a domain named `text/plain`, `application/octet-stream`, … as return type) | ✅ | Text and `bytea` bodies |

## Errors

| Feature | Status | Notes |
| --- | --- | --- |
| PostgREST error body `{code, message, details, hint}` | ✅ | |
| Parse errors of filters and `order` (`unexpected "f" expecting …`, line/column) | ✅ | Same wording as PostgREST's Parsec parser |
| Parse errors of `select` and `and()`/`or()` | ✅ | Ported PostgREST's Parsec grammar: same wording, and the same leniency (the select parse stops where it cannot continue, `select=id)` works) |
| Invalid / odd payloads (`[]`, scalars, arrays of scalars, array on `PATCH`) | ✅ | Same status and message as PostgREST |
| `PGRST1xx`–`PGRST3xx` codes (parsing, schema cache, auth) | ✅ | Most; `PGRST3xx` JWT codes are replaced by whatever `resolveContext` throws |
| SQLSTATE → HTTP status table | ✅ | |
| `RAISE ... SQLSTATE 'PTxyz'` → HTTP status | ✅ | |
| `RAISE ... SQLSTATE 'PGRST'` with JSON message / detail | ✅ | |
| `WWW-Authenticate` header on 401 | ✅ | `Bearer` |
| Serialization failure retry | ✅ | Up to 2 retries on `40001` |

## Other

| Feature | Status | Notes |
| --- | --- | --- |
| OpenAPI (Swagger 2.0) at `/` | 🟡 | Tables, views, RPC, parameters, definitions; no security definitions, may differ in detail from PostgREST |
| `OPTIONS` / CORS | 🟡 | `OPTIONS` handled with `Allow`; CORS headers are the host's responsibility |
| Schema cache from `pg_catalog` | ✅ | Tables, views, columns, PK/UK/FK, functions, comments |
| Domain types, enums, range/array types | 🟡 | Passed through as Postgres returns them; only common types tested |
| Composite types: reading, writing, `->`/`->>` into their fields | ✅ | The fields are also in the schema cache (`SchemaCache.composites`) and in the generated types |
| Comparing a whole composite value (`owner=eq.…`) | ➕ | PostgREST answers `0A000` (*input of anonymous composite types is not implemented*) for any such comparison. pg-rest reads a **JSON object** as a row of the column's own type, so `select({ table, where: { owner: { … } } })` works -- see [`docs/query.md`](docs/query.md#composite-types). A bare row literal still answers `0A000` |
| `UPDATE … SET column = expression \| DEFAULT` | ➕ | A superset of PostgREST's `PATCH`, in `@tsql/query` only (`set: { total: { $add: [{ $col: "total" }, 1] } }`): over HTTP the body is still PostgREST's JSON. See [`docs/query.md`](docs/query.md#computed-values) |
| Hot-reloading on DDL | ➖ | Needs a dedicated `LISTEN` connection (see the README); call `reloadSchema()` after migrations |

## Verification status

Two layers:

1. **Own suites** – 190+ tests against a real PostgreSQL 16 (schema, parsing, reads, writes, RPC, request context, security).
2. **Differential test against PostgREST 16.5** – `packages/rest/tests/compare` starts the real `postgrest` binary and pg-rest on the *same* database
   and replays 339 requests against both (reads, filters, embedding, writes rolled back with `Prefer: tx=rollback`, RPC, errors, headers),
   diffing status, `Content-Type`, `Content-Range`, `Location`, `Preference-Applied`, `Allow` and the JSON body (error bodies included).
   10 of them need PostGIS and fail without it; of the other 329, **328 are byte-for-byte equivalent** and one is the known
   difference listed below.

```sh
mise install   # the pinned binary, see mise.toml; or fetch it yourself:
               # https://github.com/PostgREST/postgrest/releases/tag/v16.5
POSTGREST_BIN=/path/to/postgrest TEST_DATABASE_URL=postgres://user@host/postgres bun run test:compare
```

The GeoJSON cases need PostGIS and fail without it. `mise run db:start` gives a cluster that has it.

The comparison only covers what the cases exercise; it is not exhaustive. Anything not in `packages/rest/tests/compare/cases.ts` is unverified against PostgREST.
Without `POSTGREST_BIN` the whole suite skips silently rather than failing, so a green `bun test` says nothing about parity unless the
binary was present.

### Known differences (asserted by the comparison test)

One, and it is deliberate. The test asserts it still differs, so it cannot go stale unnoticed.

| Case | PostgREST 16 | pg-rest |
| --- | --- | --- |
| Invalid cast target (`select=id::int4 from x`) | forwarded to PostgreSQL → `42601` | rejected up front: `400 PGRST100` (SQL-injection hardening) |

### Differences found by the comparison and fixed

Content-Range on RPC / PATCH responses, `Cannot coerce the result to a single JSON object` text, `406` for unsupported `Accept`,
`nulls=stripped` media types, `416` carrying `Content-Range` and `Preference-Applied`, `PGRST102` for bulk inserts with differing keys,
PUT error texts, PGRST202/203 texts, fewer "did you mean" hints, real table names in PostgreSQL error messages, `HEAD` content type,
embedding by foreign-key column (`c:client_id(*)`), self-reference resolution (table name → children, column name → parent).

Then, all previously listed as known differences: CSV of array columns (now PostgreSQL's own record text, `{a,b}`, quoted exactly as
PostgREST quotes it), `limit=abc` ignored rather than `PGRST100`, `order=rel(col)` on a relation that is not embedded (`PGRST108`),
`merge-duplicates` upsert that only updates returning `200`, the `details` of an invalid JSON body, a single unnamed `json` parameter
given an array body with differing keys, `Accept: text/csv` on a scalar function result, and `TRACE` answering with an empty body.

### Configuration differences used by the comparison

PostgREST runs with `db-aggregates-enabled=true` (off by default in v16; pg-rest always allows aggregates) and `db-tx-end=commit-allow-override`.
