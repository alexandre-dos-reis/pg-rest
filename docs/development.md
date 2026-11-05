# Development

```sh
bun install
mise install        # PostgREST 16.5, the official static release
mise run db:start   # a throwaway Postgres 16 + PostGIS under .cache/ (also db:stop, db:reset)
mise run test       # the whole suite, differential and GeoJSON cases included
```

`mise.toml` pins the PostgREST binary the differential test needs and runs the cluster the integration tests use.
Nothing is installed system-wide. PostGIS is **required**: the `application/geo+json` cases fail without it rather than
skipping, which is how nine stale parity differences were once found hiding behind a skip.

Or bring your own Postgres 16 and PostgREST:

```sh
TEST_DATABASE_URL=postgres://user@host:5432/postgres bun test          # a server you can create databases on
POSTGREST_BIN=/path/to/postgrest TEST_DATABASE_URL=... bun run test:compare
bun run typecheck && bun run lint && bun run fmt:check && bun run build
```

Integration tests are **skipped** without `TEST_DATABASE_URL`, and the differential ones without `POSTGREST_BIN`, so a
green `bun test` with neither proves little. Each suite creates and drops its own database: never point it at data you
care about.

## What the suites cover

| | |
| --- | --- |
| `tests/compare` | hundreds of requests replayed against the real PostgREST 16.5 binary, statuses, headers and bodies compared. Run it whenever you touch parsing, SQL generation, error codes or headers |
| `tests/read`, `write`, `rpc`, `media`, `geojson`, `plan`, `context`, `schema` | the behaviour of `handle()`, feature by feature |
| `tests/query.test.ts` | the object API, and that it answers exactly what `handle()` does |
| `tests/typed.test.ts` | the typed input: exact result types, and `@ts-expect-error` on every mistake it must refuse |
| `tests/completions.test.ts` | what an editor offers inside a typed query, asked of the TypeScript language service |
| `tests/types.test.ts` | the generator, and the committed `fixture.types.ts` byte for byte |
| `tests/docs.test.ts` | every TypeScript block in the README and `docs/`, compiled |
| `tests/clients.test.ts` | `@supabase/postgrest-js` and `@neondatabase/postgrest-js` driving `handle()` through their own query builders, with the handler passed as their `fetch` |
| `tests/security.test.ts` | hostile input through both entry points |
| `tests/agnostic.test.ts` | the four adapters against the same expectations, and the examples' consistency |

## The examples

They depend on `pg-rest` by version, like a real project, so a plain `bun install` inside one cannot resolve a version
that is not published yet:

```sh
bun run link:examples [name]    # builds pg-rest, then symlinks it into the example's node_modules
bun run check:examples          # asserts every example matches the root package.json version
```

Never a `file:` or `link:` path in an example's `package.json` — `check:examples` refuses it, and `bun install` would
copy a partial snapshot of the repository instead of linking it.

Run one end to end, the way CI does:

```sh
scripts/check-example.sh with-node-postgres postgres://user@host:5432/mydb   # a server example
scripts/check-example.sh with-generated-types                                # the one without a server
```

## Releasing

Changesets, nothing published by hand:

```sh
bun run changeset   # a note saying patch/minor/major and what changed; commit it with the change
```

CI on `main` turns pending notes into a "chore: version packages" pull request; merging that publishes to npm with
provenance, through trusted publishing. `bun run version` is what that PR runs — it also moves the examples onto the new
version. A change with nothing to release (tests, docs, CI) needs no changeset.

[`AGENTS.md`](../AGENTS.md) has the conventions, the gotchas, and what each invariant protects.
