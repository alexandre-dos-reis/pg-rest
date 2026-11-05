# AGENTS.md

Guide for coding agents working on **pg-rest**: a PostgREST v16-compatible REST layer shipped as a library.
Read `README.md` for usage and `PARITY.md` for what is and isn't implemented before changing behaviour.

## What this is

- Two entry points over **one** pipeline: `handle(Request) => Response` and `query(object) => { data, count, status }`.
  The object is turned into the query parameters `parseQuery` takes, so parsing, planning, SQL, `set_config` and error
  mapping are shared; only the HTTP envelope (content negotiation, `Range`, plans, OpenAPI) is `handle`-only. Never fork
  that pipeline: a feature added to one entry point must come from the shared code, and `tests/query.test.ts` pins that the
  two answer identically, error bodies included.
- A web-standard `handle(Request) => Response` (`createPgRest(options)` in `src/index.ts`). No HTTP server, no JWT: the consumer supplies
  `resolveContext(req)` (or passes a context to `handle`) with the role and claims, and pg-rest applies them with `set_config` so RLS works.
- Driver-agnostic: the core only knows the `DbAdapter` interface (`src/adapter.ts`). Adapters live in `src/adapters/*` and **must not import
  their driver** (structural types only); drivers are optional peer dependencies. Never add a driver import to `src/` outside tests.
- **No runtime dependencies.** Don't add one. (Effect was removed on purpose: see PR #5.)
- Target runtimes: Bun and Node (tested on Node 22). Don't use `Bun.*` APIs in `src/`.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | `createPgRest`, public types and exports |
| `src/core.ts` | request handling: routing, content negotiation, response building; `planTable`/`planRpc`/`execute` are shared with `query` |
| `src/query.ts` | `query(input)`: the object API, in-process, no `Request` (see below) |
| `src/parse/*` | URL/query parsing: `select`, filters, request headers, fields |
| `src/sql/*` | SQL generation (`read`, `write`, `rpc`, `filters`, `statement`) |
| `src/schema.ts` | schema introspection and cache |
| `src/types.ts` | `generateTypes(cache)`: TypeScript types from the catalog, published as `pg-rest/types` |
| `src/typed.ts` | types only: `createPgRest<Db>` input and result inference over a generated database type |
| `tests/completions.test.ts` | what an editor offers inside a typed query, asked of the TypeScript language service |
| `src/service.ts` | schema store (serialized reload), error mapping, `handleSafely` |
| `src/errors.ts` | `ApiError`, PostgREST error codes (`PGRSTxxx`), `normalizeDbError` (maps SQLSTATE) |
| `src/openapi.ts` | OpenAPI document |
| `src/quote.ts` | identifier/literal quoting: all SQL identifiers go through it |
| `src/adapters/*` | bun, node-postgres, postgres-js, pglite (published as `pg-rest/adapters/*`) |
| `tests/` | `bun test` suites; `tests/support` has the fixture schema (`fixture.sql`) and helpers |
| `tests/support/fixture.types.ts` | `generateTypes` output for the fixture, committed: `tests/types.test.ts` pins it byte-for-byte and `typecheck` proves it compiles. Regenerate it when the fixture or the generator changes; it is in `.oxfmtrc.json`'s ignore list so the formatter cannot rewrite generated output |
| `tests/compare/` | differential tests against a real PostgREST 16 binary |
| `examples/with-*` | independent runnable examples, each with its own `package.json` |
| `bench/` | load tests vs PostgREST (see `bench/README.md`) |
| `scripts/` | `check-example.sh` (end-to-end check of an example), `node-smoke.ts`, `check-example-versions.ts`, `link-examples.sh`, `githooks/pre-commit` |
| `mise.toml` | the pinned PostgREST binary, and the tasks that run a Postgres 16 + PostGIS cluster |

## Commands

```bash
bun install
mise install           # the pinned PostgREST binary (tests/compare); see mise.toml
mise run db:start      # Postgres 16 + PostGIS on $PGPORT, under .cache/ (also db:stop, db:reset)
mise run test          # the whole suite against that cluster and that binary
bun run typecheck      # tsc --noEmit (src and tests only; bench/, scripts/ and examples/ are not typechecked)
bun run lint           # oxlint on src and tests (config: .oxlintrc.json)
bun run fmt            # oxfmt --write (config: .oxfmtrc.json); fmt:check is what CI runs
bun run build          # tsdown -> dist/ (index.js and adapters/*.js)
bun test               # unit + integration; integration tests need TEST_DATABASE_URL
bun run test:compare   # needs POSTGREST_BIN and TEST_DATABASE_URL
bun run bench          # see bench/README.md
bun run check:examples # every example depends on the root pg-rest version (--fix rewrites them)
bun run link:examples  # point the examples at the local build, without touching their package.json
```

- Integration tests are **skipped** (not failed) without `TEST_DATABASE_URL`: a superuser URL of a throwaway PostgreSQL 16 server. Each test
  suite creates and drops its own database, so never point it at data you care about. A green `bun test` with no database proves little: run it
  with one.
- That server **must have PostGIS**: the `application/geo+json` cases used to skip without it and now fail, which is how they were found to match
  PostgREST all along while `PARITY.md` still listed eight differences as open. `mise run db:start` provides it; CI uses `postgis/postgis:16-3.6`.
- The comparison tests are skipped without `POSTGREST_BIN` (a PostgREST **v16.5** static binary; `mise install` fetches it, CI downloads the same
  release). Run them whenever you touch parsing, SQL generation, error codes or response headers.
- Examples depend on `pg-rest` by version, like a real project, so `bun install` inside one cannot resolve it until that version is published.
  Use `bun run link:examples [name]`. `bun run version` moves them onto each new release, and `scripts/githooks/pre-commit` (wired up by the
  `prepare` script on `bun install`) refuses a commit that leaves them out of step with the root `package.json`.
- CI (`.github/workflows/ci.yml`): typecheck + build + tests on PostgreSQL 16, a Node job (`scripts/node-smoke.ts` against the built `dist`),
  an examples matrix (`scripts/check-example.sh`), and the PostgREST differential test.
- Typecheck runs before the build in CI, so `src`/`tests` code must not import from `dist`.

## Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets); nothing is published by hand.

```bash
bun run changeset      # a note saying patch/minor/major and what changed; commit it with the change
```

`.github/workflows/release.yml` runs after CI passes on `main`: pending notes become a **"chore: version packages"** PR, and
merging that PR publishes to npm and tags a GitHub release. `bun run version` is what the PR runs -- it bumps `package.json`,
writes `CHANGELOG.md`, and points the examples at the new version, since they depend on `pg-rest` by version and would
otherwise ask npm for one that does not exist.

A change with nothing to release (tests, docs, CI) needs no changeset.

There is **no npm token**: publishing authenticates with [trusted publishing](https://docs.npmjs.com/trusted-publishers),
where the npm CLI exchanges the workflow's OIDC token for a short-lived credential — hence `id-token: write`, and hence no
`NODE_AUTH_TOKEN` (it would take precedence and defeat it). Configure it once at *npmjs.com → Packages → pg-rest → Settings
→ Trusted publishing*, naming `release.yml`; a new configuration expires if its first publish does not happen within 2 days.
Releases carry provenance, so they are attested to the workflow that built them.

## Conventions and gotchas

- **One union member per table** in `src/typed.ts`. TypeScript narrows the contextual type of a nested property (the items
  of `select`, the keys of `where`) only when the discriminant picks exactly one member, so reads and writes share one
  member per table -- each action's payload is required, and refused on the others, by `WriteRules` rather than by the
  shape -- and *every* member declares `table`, function calls included (`table?: never`). Split them again, or add a
  member without `table`, and the editor silently starts offering every table's columns while the compiler stays right.
  `tests/completions.test.ts` asks the language service and pins it.
- **Parity first.** The goal is identical observable behaviour to PostgREST v16 (status codes, headers, error JSON, `PGRST` codes). When unsure,
  check PostgREST's behaviour with the comparison tests rather than guessing. Update `PARITY.md` when a row changes.
- **SQL safety.** Values are passed as parameters (only `text` params, each cast explicitly in SQL, e.g. `$1::text`) so adapters need no type
  inference. Identifiers go through `src/quote.ts`. Never interpolate request data into SQL. `tests/security.test.ts` covers this; extend it.
- **Errors.** Throw `ApiError` (status, PostgREST-shaped body, headers). `body` is the wire format and must stay exactly
  PostgREST's; `Error.message` is a human summary (code, details, hint) and is free to change. `query()` throws a
  `QueryError` carrying the same body plus the input. Database errors become `DbQueryError` in the adapter and are mapped by
  SQLSTATE in `normalizeDbError`. If a new driver reports errors differently, fix it in the adapter or in `normalizeDbError`, not in the core.
- **Adding an adapter** = implement `DbAdapter` (`query`, `transaction`, optional `close`), add a subpath entry in `tsdown.config.ts` and
  `package.json` `exports`, an optional peer dependency, a test in `tests/agnostic.test.ts`, an `examples/with-*`, and a CI matrix entry.
- **Built entry points.** `package.json` points at `dist/*.js` and `dist/*.d.ts` (tsdown emits `.js`, not `.mjs`). Keep them in sync if the
  build config changes.
- Strict TypeScript; follow the existing style (small modules, explicit types on exports, doc comments on public API).
- Don't commit `dist/`, `bench/results/` (both ignored) or database dumps.

## Benchmarks

`bench/run.ts` needs `POSTGREST_BIN` (`mise install`, or `mise which postgrest`) and `BENCH_ADMIN_URL` (superuser URL of a throwaway server), and a built `dist/`. A full run takes about
12 minutes for 5 servers (run it in the background). Findings so far are in `bench/README.md`; they come from a 2-vCPU sandbox and are indicative
only, with a few percent of noise between runs. `bun compile` (experimental AOT, `--compile --aot`) exists only in recent canary Bun builds; point
`AOT_BUN` at one. Don't claim a performance improvement from a single run.

## Git

- Work on a branch and open a PR; don't push to `main` directly. Keep PRs focused, and make sure CI passes before merging.
