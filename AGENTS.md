# AGENTS.md

Guide for coding agents working on **pg-rest**: a PostgREST v16-compatible REST layer shipped as a library.
Read `README.md` for usage and `PARITY.md` for what is and isn't implemented before changing behaviour.

## What this is

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
| `src/core.ts` | request handling: routing, content negotiation, response building |
| `src/parse/*` | URL/query parsing: `select`, filters, request headers, fields |
| `src/sql/*` | SQL generation (`read`, `write`, `rpc`, `filters`, `statement`) |
| `src/schema.ts` | schema introspection and cache |
| `src/service.ts` | schema store (serialized reload), error mapping, `handleSafely` |
| `src/errors.ts` | `ApiError`, PostgREST error codes (`PGRSTxxx`), `normalizeDbError` (maps SQLSTATE) |
| `src/openapi.ts` | OpenAPI document |
| `src/quote.ts` | identifier/literal quoting: all SQL identifiers go through it |
| `src/adapters/*` | bun, node-postgres, postgres-js, pglite (published as `pg-rest/adapters/*`) |
| `tests/` | `bun test` suites; `tests/support` has the fixture schema (`fixture.sql`) and helpers |
| `tests/compare/` | differential tests against a real PostgREST 16 binary |
| `examples/with-*` | independent runnable examples, each with its own `package.json` |
| `bench/` | load tests vs PostgREST (see `bench/README.md`) |
| `scripts/` | `check-example.sh` (end-to-end check of an example), `node-smoke.ts` |

## Commands

```bash
bun install
bun run typecheck      # tsc --noEmit (src and tests only; bench/, scripts/ and examples/ are not typechecked)
bun run build          # tsdown -> dist/ (index.js and adapters/*.js)
bun test               # unit + integration; integration tests need TEST_DATABASE_URL
bun run test:compare   # needs POSTGREST_BIN and TEST_DATABASE_URL
bun run bench          # see bench/README.md
```

- Integration tests are **skipped** (not failed) without `TEST_DATABASE_URL`: a superuser URL of a throwaway PostgreSQL 16 server. Each test
  suite creates and drops its own database, so never point it at data you care about. A green `bun test` with no database proves little: run it
  with one.
- The comparison tests are skipped without `POSTGREST_BIN` (a PostgREST **v16.0** static binary; CI downloads it from the GitHub release).
  Run them whenever you touch parsing, SQL generation, error codes or response headers.
- CI (`.github/workflows/ci.yml`): typecheck + build + tests on PostgreSQL 16, a Node job (`scripts/node-smoke.ts` against the built `dist`),
  an examples matrix (`scripts/check-example.sh`), and the PostgREST differential test.
- Typecheck runs before the build in CI, so `src`/`tests` code must not import from `dist`.

## Conventions and gotchas

- **Parity first.** The goal is identical observable behaviour to PostgREST v16 (status codes, headers, error JSON, `PGRST` codes). When unsure,
  check PostgREST's behaviour with the comparison tests rather than guessing. Update `PARITY.md` when a row changes.
- **SQL safety.** Values are passed as parameters (only `text` params, each cast explicitly in SQL, e.g. `$1::text`) so adapters need no type
  inference. Identifiers go through `src/quote.ts`. Never interpolate request data into SQL. `tests/security.test.ts` covers this; extend it.
- **Errors.** Throw `ApiError` (status, PostgREST-shaped body, headers). Database errors become `DbQueryError` in the adapter and are mapped by
  SQLSTATE in `normalizeDbError`. If a new driver reports errors differently, fix it in the adapter or in `normalizeDbError`, not in the core.
- **Adding an adapter** = implement `DbAdapter` (`query`, `transaction`, optional `close`), add a subpath entry in `tsdown.config.ts` and
  `package.json` `exports`, an optional peer dependency, a test in `tests/agnostic.test.ts`, an `examples/with-*`, and a CI matrix entry.
- **Built entry points.** `package.json` points at `dist/*.js` and `dist/*.d.ts` (tsdown emits `.js`, not `.mjs`). Keep them in sync if the
  build config changes.
- Strict TypeScript; follow the existing style (small modules, explicit types on exports, doc comments on public API).
- Don't commit `dist/`, `bench/results/` (both ignored) or database dumps.

## Benchmarks

`bench/run.ts` needs `POSTGREST_BIN` and `BENCH_ADMIN_URL` (superuser URL of a throwaway server), and a built `dist/`. A full run takes about
12 minutes for 5 servers (run it in the background). Findings so far are in `bench/README.md`; they come from a 2-vCPU sandbox and are indicative
only, with a few percent of noise between runs. `bun compile` (experimental AOT, `--compile --aot`) exists only in recent canary Bun builds; point
`AOT_BUN` at one. Don't claim a performance improvement from a single run.

## Git

- Work on a branch and open a PR; don't push to `main` directly. Keep PRs focused, and make sure CI passes before merging.
