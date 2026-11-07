# Database adapters

`db` is a `DbAdapter` — the only thing pg-rest needs from a driver:

```ts ignore
interface DbAdapter {
  query(text: string, params?: (string | null)[]): Promise<Record<string, unknown>[]>;
  /** One connection, BEGIN/COMMIT/ROLLBACK: commit when `fn` resolves, roll back and rethrow when it throws. */
  transaction<A>(fn: (session: { query: DbAdapter["query"] }) => Promise<A>): Promise<A>;
  close?(): Promise<void>;
}
```

## The four that ship

They are exported by both packages, under the same names: `@tsql/rest/adapters/*` and `@tsql/query/adapters/*`. The table
uses `@tsql/rest`.

| import | wraps | peer dependency |
| --- | --- | --- |
| `@tsql/rest/adapters/bun` → `bunSqlAdapter(sql)` | `new SQL(url)` from `"bun"` | none (built into Bun) |
| `@tsql/rest/adapters/node-postgres` → `nodePostgresAdapter(pool)` | `new pg.Pool(…)` | `pg` ≥ 8 |
| `@tsql/rest/adapters/postgres-js` → `postgresJsAdapter(sql)` | `postgres(url)` | `postgres` ≥ 3 |
| `@tsql/rest/adapters/pglite` → `pgliteAdapter(db)` | `new PGlite()` | `@electric-sql/pglite` |

They are **structural**: an adapter never imports its driver, you pass the client in. So a project loads only the code
it imports, and the drivers stay optional peer dependencies.

```ts
import pg from "pg";
import { nodePostgresAdapter } from "@tsql/rest/adapters/node-postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const rest = await createRest({ db: nodePostgresAdapter(pool), schemas: ["api"] });
```

The libraries never close your driver: `rest.close()` stops the handler, the pool is yours to end.

## Writing one

About twenty lines; the sources in [`packages/core/src/adapters`](../packages/core/src/adapters) are good templates. Two things make it easy:

- **Parameters are always text**, with an explicit `$n::text` cast in the SQL, so an adapter needs no type inference and
  no driver-specific binding. Values arrive as `string | null`.
- **Errors are recognised by SQLSTATE**, read from `code`, `errno` or `sqlState` on whatever the driver throws
  (`normalizeDbError` in [`packages/core/src/errors.ts`](../packages/core/src/errors.ts)), so an adapter does not translate them. Anything without a
  SQLSTATE — a connection failure, a bug — passes through and becomes a `503`/`500`.

`transaction` must run `fn` on a **single** connection and own the `BEGIN`/`COMMIT`/`ROLLBACK`: the role, the claims and
the `search_path` are set with `set_config(…, true)`, which is transaction-local, and a request that is not in one would
leak its caller into the next.

Adding one to the repository: implement the interface, add an entry to `tsdown.config.ts` and to `package.json`'s
`exports`, an optional peer dependency, a case in `tests/agnostic.test.ts`, an `examples/with-*`, and a line in the CI
matrix.

## What SQL sees

Whatever the driver, policies read the same GUCs as behind PostgREST:

```sql
CREATE POLICY own ON api.notes
  USING (owner = (current_setting('request.jwt.claims', true)::json ->> 'sub'));
```

`request.method`, `request.path`, `request.headers` and `request.cookies` are there too (`requestSettings`, on by
default) — empty for an in-process `query()`, which has no headers. See [`security.md`](security.md).
