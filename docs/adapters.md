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

They are exported by both packages, under the same names: `@tspg/rest/adapters/*` and `@tspg/query/adapters/*`. The table
uses `@tspg/rest`.

| import | wraps | peer dependency |
| --- | --- | --- |
| `@tspg/rest/adapters/bun` → `bunSqlAdapter(sql)` | `new SQL(url)` from `"bun"` | none (built into Bun) |
| `@tspg/rest/adapters/node-postgres` → `nodePostgresAdapter(pool)` | `new pg.Pool(…)` | `pg` ≥ 8 |
| `@tspg/rest/adapters/postgres-js` → `postgresJsAdapter(sql)` | `postgres(url)` | `postgres` ≥ 3 |
| `@tspg/rest/adapters/pglite` → `pgliteAdapter(db)` | `new PGlite()` | `@electric-sql/pglite` |

They are **structural**: an adapter never imports its driver, you pass the client in. So a project loads only the code
it imports, and the drivers stay optional peer dependencies.

```ts
import pg from "pg";
import { nodePostgresAdapter } from "@tspg/rest/adapters/node-postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const rest = await createRest({ db: nodePostgresAdapter(pool), schemas: ["api"] });
```

`rest.close()` stops the handler and ends the pool — `close()` calls the adapter's own `close()` (`pool.end()`,
`sql.end()`, `pglite.close()`; nothing, for an adapter that has none), and does it once however often it is called. The
`onClose` option takes that over, the adapter handed back as `db`:

```ts
const db = nodePostgresAdapter(pool);
// the pool outlives the handler: the application ends it
const rest = await createRest({ db, schemas: ["api"], onClose: () => {} });
```

That is what a driver shared between instances needs — an app that uses both packages creates two instances over one
adapter, and whichever closes first would otherwise end the pool under the other. Give `onClose: () => {}` to all but
one of them, or to all of them and end the driver yourself.

## Writing one

About twenty lines; the sources in [`packages/adapters/src`](../packages/adapters/src) are good templates. Two things make it easy:

- **Parameters are always text**, with an explicit `$n::text` cast in the SQL, so an adapter needs no type inference and
  no driver-specific binding. Values arrive as `string | null`.
- **Errors are recognised by SQLSTATE**, read from `code`, `errno` or `sqlState` on whatever the driver throws
  (`normalizeDbError` in [`packages/core/src/errors.ts`](../packages/core/src/errors.ts)), so an adapter does not translate them. Anything without a
  SQLSTATE — a connection failure, a bug — passes through and becomes a `503`/`500`.

`transaction` must run `fn` on a **single** connection and own the `BEGIN`/`COMMIT`/`ROLLBACK`: the role, the claims and
the `search_path` are set with `set_config(…, true)`, which is transaction-local, and a request that is not in one would
leak its caller into the next.

Adding one to the repository: implement the interface, add an entry to `tsdown.config.ts` and to `package.json`'s
`exports`, an optional peer dependency, a case in `tests/agnostic.test.ts`, an `examples/rest/with-*` or `examples/query/with-*`, and a line in the CI
matrix.

## What SQL sees

Whatever the driver, policies read the same GUCs as behind PostgREST:

```sql
CREATE POLICY own ON api.notes
  USING (owner = (current_setting('request.jwt.claims', true)::json ->> 'sub'));
```

Over HTTP, `request.method`, `request.path`, `request.headers` and `request.cookies` are there too (`requestSettings`, on by
default); an in-process operation has no request and sets none of them. See [`security.md`](security.md).
