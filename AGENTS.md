# AGENTS.md

Guide for coding agents working on **tsql**: a monorepo of `@tsql/rest` (a PostgREST v16-compatible REST layer shipped as a library) and `@tsql/query` (the same engine in-process, typed, with extensions PostgREST does not have).
Before changing behaviour, read `PARITY.md` for what is and isn't implemented, `docs/design.md` for what is out of
scope on purpose, and `docs/architecture.md` for how a request becomes SQL. `README.md` is deliberately short: the
reference lives in `docs/`.

## What this is

- **Three packages under `packages/`.** `@tsql/rest` (`createRest` -> `handle(Request) => Response`) and `@tsql/query`
  (`createQuery` -> `query()`, `transaction()`, `setContextQuery()`, `generateTypes()`) are published. `@tsql/core` is
  **private**: parsing, planning, SQL, the schema cache, errors and the adapters, bundled by tsdown into each published
  package (it is a `devDependency` on purpose -- tsdown only externalises `dependencies`). The import direction is
  one way: `rest` and `query` import `@tsql/core/*`, never each other, and `core` imports neither. Never add a
  dependency on `@tsql/core` under `dependencies`, and never import `rest` from `query` or the reverse.
- **Parity belongs to `@tsql/rest`.** Anything that is not PostgREST -- the `$` filters, the computed `set`, the typed layer --
  is `@tsql/query` only, and must not change what `handle()` does (`tests/compare` pins that against a real PostgREST).
  HTTP-only settings (`basePath`, `allowTxOverride`, `planEnabled`, `openApi`, `serverUrl`) are `HttpConfig`, in `rest`.
- Each package keeps its own schema cache: an app that uses both creates both. `tests/support/pgrest.ts` is the test-only
  `createPgRest` that composes the two on one database.

- Two entry points over **one** pipeline (in `@tsql/core`): `handle(Request) => Response` and
  `query(object) => { data, count, status, error }`. Neither rejects: a failure is a response, or the `error` of a result.
  The object is built into the `ParsedQuery` that `rest`'s `parseQuery` produces from a query string (no text in between, no grammar in `@tsql/query`), so planning, SQL, `set_config` and error
  mapping are shared; only the HTTP envelope (content negotiation, `Range`, plans, OpenAPI) is `handle`-only. Never fork
  that pipeline: a feature added to one entry point must come from the shared code, and `tests/query.test.ts` pins that the
  two answer identically, error bodies included.
- A web-standard `handle(Request) => Response` (`createRest(options)` in `packages/rest/src/index.ts`). No HTTP server, no JWT: the consumer supplies
  `resolveContext(req)` (or passes a context to `handle`) with the role and claims, and pg-rest applies them with `set_config` so RLS works.
- Driver-agnostic: the core only knows the `DbAdapter` interface (`packages/core/src/adapter.ts`). Adapters live in `packages/core/src/adapters/*` (each published package re-exports them) and **must not import
  their driver** (structural types only); drivers are optional peer dependencies. Never add a driver import to `packages/*/src/` outside tests.
- **No runtime dependencies.** Don't add one. (Effect was removed on purpose: see PR #5.) The two PostgREST client
  libraries in `devDependencies` are there for `tests/clients.test.ts`, which checks that real clients still work
  against `handle()`; they never reach `packages/*/src/`.
- Target runtimes: Bun and Node (tested on Node 22). Don't use `Bun.*` APIs in `packages/*/src/`.

## Layout

| Path | What |
| --- | --- |
| `packages/rest/src/index.ts` | `@tsql/rest`: `createRest`, `RestOptions`, the HTTP-only settings |
| `packages/rest/src/http.ts` | `handleRequest`: routing, content negotiation, OpenAPI root, plans, cookies and headers for SQL, the `Response` (`HttpConfig`) |
| `packages/rest/src/request.ts` | reading HTTP: method, path, `Prefer`, `Range`, `Accept`, the body |
| `packages/rest/src/render.ts` | the SQL of CSV, GeoJSON and media type handlers; the engine only knows `OutputFormat` (`json`, `object`, or `rendered` by SQL it is given) |
| `packages/rest/src/serve.ts`, `media.ts`, `openapi.ts` | `handleSafely`/`errorResponse`, custom media types, the OpenAPI document |
| `packages/query/src/index.ts` | `@tsql/query`: `createQuery`, `QueryInstance`, the public types |
| `packages/query/src/query.ts` | `query(input)`: the object API, in-process, no `Request` (see below) |
| `packages/query/src/kinds.ts` | `ErrorKind` and `describeFailure`: how an `EngineError` (by `reason`) or a `DbQueryError` (by SQLSTATE) becomes the `kind` of a `QueryError` |
| `packages/rest/src/errors.ts` | `PgRestError`, `ApiError`, the `reason` → PostgREST status and `PGRSTxxx` code table, the SQLSTATE → status table, the `PT`/`PGRST` `RAISE` conventions, `toApiError` |
| `packages/query/src/typed.ts` | types only: `createQuery<Db>` input and result inference over a generated database type |
| `packages/query/src/types.ts` | `generateTypes(cache)`: TypeScript types from the catalog, published as `@tsql/query/types` |
| `packages/core/src/core.ts` | `planTable`/`planRpc`/`execute` (returns an `Outcome`: status, headers, body), the transaction setup: shared by `handle` and `query`. Nothing in it reads or writes HTTP: `Response`, `Accept`, `Range`, cookies, the `request.*` settings and `preRequest` are the packages', handed to `execute` as a `Call` (`settings`, `before`) |
| `packages/core/src/engine.ts` | `createEngine(options)`: the adapter wrapper, the settings both share, the first schema read |
| `packages/core/src/parse/*` | the engine's input (`ParsedQuery`) and the hand-written readers of columns, select items, order terms; no grammar |
| `packages/rest/src/parse/*` | PostgREST's query-string grammar (`parsec.ts`, `grammar.ts`) and `parseQuery` |
| `packages/core/src/sql/*` | SQL generation (`read`, `write`, `rpc`, `filters`, `statement`, `expression`) |
| `packages/core/src/schema.ts` | schema introspection and cache |
| `tests/completions.test.ts` | what an editor offers inside a typed query, asked of the TypeScript compiler |
| `tests/support/tsapi.ts` | the virtual TypeScript project `completions.test.ts` and `docs.test.ts` compile in: TypeScript 7 ships no in-process compiler, so both drive the native one over `typescript/async` |
| `docs/*.md` | the reference: `query`, `types`, `options`, `adapters`, `design`, `architecture`, `security`, `performance`, `development`. **Every `ts` block is compiled** by `tests/docs.test.ts` -- the README's against `examples/query/with-generated-types/db.generated.ts`, everything in `docs/` against `tests/support/fixture.types.ts` -- so an example that drifts fails the build; the ones meant to be refused carry `@ts-expect-error`, and a block that cannot compile is fenced ```` ```ts ignore ````. The same test asserts every relative link resolves, and that each page is linked from the README |
| `packages/core/src/service.ts` | schema store (serialized reload), error mapping |
| `packages/core/src/errors.ts` | `EngineError` (a `reason`, no code and no status), `DbQueryError`, `normalizeDbError` (maps SQLSTATE), `isConnectionError` |
| `packages/core/src/quote.ts` | identifier/literal quoting: all SQL identifiers go through it |
| `packages/core/src/adapters/*` | bun, node-postgres, postgres-js, pglite (published as `@tsql/rest/adapters/*` and `@tsql/query/adapters/*`) |
| `tests/` | `bun test` suites, importing the packages' sources; `tests/support` has the fixture schema (`fixture.sql`) and helpers, and `pgrest.ts`, which composes `createRest` and `createQuery` |
| `tests/support/fixture.types.ts` | `generateTypes` output for the fixture, committed: `tests/types.test.ts` pins it byte-for-byte and `typecheck` proves it compiles. Regenerate it when the fixture or the generator changes; it is in `.oxfmtrc.json`'s ignore list so the formatter cannot rewrite generated output |
| `tests/compare/` | differential tests against a real PostgREST 16 binary |
| `examples/rest/with-*`, `examples/query/with-*` | independent runnable examples, one folder per package (`@tsql/rest`, `@tsql/query`), each with its own `package.json` |
| `bench/` | load tests vs PostgREST (see `bench/README.md`) |
| `scripts/` | `check-example.sh` (end-to-end check of an example), `node-smoke.ts`, `check-example-versions.ts`, `link-examples.sh`, `githooks/pre-commit` |
| `mise.toml` | the pinned PostgREST binary, and the tasks that run a Postgres 16 + PostGIS cluster |

## Commands

```bash
bun install
mise install           # the pinned PostgREST binary (tests/compare) and micromamba; see mise.toml
mise run db:start      # Postgres 16 + PostGIS on $PGPORT, under .cache/ (also db:stop, db:reset)
mise run test          # the whole suite against that cluster and that binary
bun run typecheck      # tsc --noEmit (src and tests only; bench/, scripts/ and examples/ are not typechecked)
bun run lint           # oxlint on src and tests (config: .oxlintrc.json)
bun run fmt            # oxfmt --write (config: .oxfmtrc.json); fmt:check is what CI runs
bun run build          # tsdown in packages/rest and packages/query -> their dist/ (index.js and adapters/*.js)
bun test               # unit + integration; integration tests need TEST_DATABASE_URL
bun run test:compare   # needs POSTGREST_BIN and TEST_DATABASE_URL
bun run bench          # see bench/README.md
bun run check:examples # every example depends on the packages it uses at their version (--fix rewrites them)
bun run link:examples  # point the examples at the local build, without touching their package.json
```

- Integration tests are **skipped** (not failed) without `TEST_DATABASE_URL`: a superuser URL of a throwaway PostgreSQL 16 server. Each test
  suite creates and drops its own database, so never point it at data you care about. A green `bun test` with no database proves little: run it
  with one.
- That server **must have PostGIS**: the `application/geo+json` cases used to skip without it and now fail, which is how they were found to match
  PostgREST all along while `PARITY.md` still listed eight differences as open. `mise run db:start` provides it (PostGIS 3.5); CI uses `postgis/postgis:16-3.6`.
- The comparison tests are skipped without `POSTGREST_BIN` (a PostgREST **v16.5** static binary; `mise install` fetches it, CI downloads the same
  release). Run them whenever you touch parsing, SQL generation, error codes or response headers.
- Examples depend on `@tsql/rest` or `@tsql/query` by version, like a real project, so `bun install` inside one cannot resolve it until that version is published.
  Use `bun run link:examples [name]`. `bun run version` moves them onto each new release, and `scripts/githooks/pre-commit` (wired up by the
  `prepare` script on `bun install`) refuses a commit that leaves them out of step with the root `package.json`.
- CI (`.github/workflows/ci.yml`): typecheck + build + tests on PostgreSQL 16, a Node job (`scripts/node-smoke.ts` against the built `packages/*/dist`),
  an examples matrix (`scripts/check-example.sh`, one job per example -- the two PGlite ones need no database service),
  and the PostgREST differential test.
- Typecheck runs before the build in CI, so `packages/*/src` and `tests` code must not import from `dist`.

## Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets); nothing is published by hand.

```bash
bun run changeset      # a note saying patch/minor/major and what changed; commit it with the change
```

`.github/workflows/release.yml` runs after CI passes on `main`: pending notes become a **"chore: version packages"** PR, and
merging that PR publishes to npm and tags a GitHub release. `bun run version` is what the PR runs -- it bumps `package.json`,
writes `CHANGELOG.md`, and points the examples at the new version, since they depend on the packages by version and would
otherwise ask npm for one that does not exist.

A change with nothing to release (tests, docs, CI) needs no changeset.

There is **no npm token**: publishing authenticates with [trusted publishing](https://docs.npmjs.com/trusted-publishers),
where the npm CLI exchanges the workflow's OIDC token for a short-lived credential — hence `id-token: write`, and hence no
`NODE_AUTH_TOKEN` (it would take precedence and defeat it). Configure it once at *npmjs.com → Packages → @tsql/rest and @tsql/query → Settings
→ Trusted publishing*, naming `release.yml`; a new configuration expires if its first publish does not happen within 2 days.
Releases carry provenance, so they are attested to the workflow that built them.

## Conventions and gotchas

- **One union member per table** in `packages/query/src/typed.ts`. TypeScript narrows the contextual type of a nested property (the items
  of `select`, the keys of `where`) only when the discriminant picks exactly one member, so reads and writes share one
  member per table -- each action's payload is required, and refused on the others, by `WriteRules` rather than by the
  shape -- and *every* member declares `table`, function calls included (`table?: never`). Split them again, or add a
  member without `table`, and the editor silently starts offering every table's columns while the compiler stays right.
  `tests/completions.test.ts` asks the compiler and pins it.
- **Parity first.** The goal is identical observable behaviour to PostgREST v16 (status codes, headers, error JSON, `PGRST` codes). When unsure,
  check PostgREST's behaviour with the comparison tests rather than guessing. Update `PARITY.md` when a row changes.
- **SQL safety.** Values are passed as parameters (only `text` params, each cast explicitly in SQL, e.g. `$1::text`) so adapters need no type
  inference. Identifiers go through `packages/core/src/quote.ts`. Never interpolate request data into SQL. `tests/security.test.ts` covers this; extend it.
- **Errors.** The core has no codes and no statuses: it throws `EngineError(reason, message, details, hint)`, and each
  package consumes it on its own. `@tsql/rest` maps a `reason` to PostgREST's status and `PGRSTxxx` code (`REASONS` in
  `packages/rest/src/errors.ts`) and answers an `ApiError` whose `body` is the wire format and must stay exactly PostgREST's.
  `@tsql/query` maps it to a `kind` (`REASON_KINDS` in `packages/query/src/kinds.ts`) and returns a `QueryError` of its own
  -- `kind`, `message`, `details`, `hint`, the `sqlState` of a database error, the input and a `summary` -- as the `error`
  of its result; it never throws. `packages/query/src` must not mention PostgREST, `PGRSTxxx` codes, `ApiError` or HTTP
  statuses. A new failure in the core is a new `Reason`, with an entry in both tables (TypeScript enforces it); adding a
  *kind* is a breaking-ish widening, so prefer an existing one. Database errors become `DbQueryError` in the adapter and
  are mapped by SQLSTATE in `normalizeDbError`. If a new driver reports errors differently, fix it in the adapter or in
  `normalizeDbError`, not in the core.
- **Adding an adapter** = implement `DbAdapter` (`query`, `transaction`, optional `close`) in `packages/core/src/adapters/`, add a subpath entry in both
  `packages/rest` and `packages/query` (`tsdown.config.ts` and `package.json` `exports`), an optional peer dependency, a test in `tests/agnostic.test.ts`, an `examples/rest/with-*` or `examples/query/with-*`, and a CI matrix entry.
- **Built entry points.** Each published package's `package.json` points at its `dist/*.js` and `dist/*.d.ts` (tsdown emits `.js`, not `.mjs`). Keep them in sync if the
  build config changes.
- Strict TypeScript; follow the existing style (small modules, explicit types on exports, doc comments on public API).
- Don't commit `dist/`, `bench/results/` (both ignored) or database dumps.

## Benchmarks

`bench/run.ts` needs `POSTGREST_BIN` (`mise install`, or `mise which postgrest`) and `BENCH_ADMIN_URL` (superuser URL of a throwaway server), and a built `packages/rest/dist`. A full run takes about
12 minutes for 5 servers (run it in the background). Findings so far are in `bench/README.md`; they come from a 2-vCPU sandbox and are indicative
only, with a few percent of noise between runs. `bun compile` (experimental AOT, `--compile --aot`) exists only in recent canary Bun builds; point
`AOT_BUN` at one. Don't claim a performance improvement from a single run.

## Git

- Work on a branch and open a PR; don't push to `main` directly. Keep PRs focused, and make sure CI passes before merging.
