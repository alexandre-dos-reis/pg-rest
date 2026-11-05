# pg-rest

A [PostgREST](https://postgrest.org) (v16 behaviour) reimplementation as a **library**: a web-standard
`handle(Request) => Promise<Response>` on top of a tiny database-adapter interface.

- **Runtime-agnostic.** The core uses only web standards (`Request`/`Response`/`Headers`) and has no driver and no runtime API
  of its own. It is tested on Bun and Node.js 22 and should run anywhere your Postgres driver does.
- **Bring your own driver.** You create the driver and pass it in through a small adapter. Adapters for
  Bun.sql, node-postgres, postgres.js and PGlite ship as separate entry points (`pg-rest/adapters/*`); the drivers are
  _optional peer dependencies_, so you only install the one you use.
- **No JWT and no server.** You decide who the caller is (cookie, API key, session, mTLS…) and hand pg-rest a role, claims and
  settings; they are applied per request with `set_config`, so Postgres Row Level Security sees them exactly as it would behind PostgREST.
- **Callable without HTTP.** Being a library, it also answers a plain JavaScript object: `query({ table: "todos", select: ["id"], limit: 10 })`
  runs in-process, through the same parser, the same SQL and the same errors. A server cannot offer that. See
  [In-process queries](#in-process-queries).

## Quick start

```sh
npm i @adrdp/pg-rest pg         # or: bun add @adrdp/pg-rest (Bun.sql is built in), postgres, @electric-sql/pglite
```

```ts
import pg from "pg";
import { createPgRest } from "@adrdp/pg-rest";
import { nodePostgresAdapter } from "@adrdp/pg-rest/adapters/node-postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const pgRest = await createPgRest({
  db: nodePostgresAdapter(pool), // you create and close the driver
  schemas: ["api"], // first one is the default schema
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

## In-process queries

> Reference with an example for every field: **[`docs/query.md`](docs/query.md)**.

Your own code often needs the same data as your HTTP clients — in a server component, a job, a webhook handler. Behind a
PostgREST server you would have to call yourself over the network, or write the SQL twice. pg-rest runs inside your process,
so it answers an object instead:

```ts
const { data } = await pgRest.query({
  table: "todos",
  select: ["id", "title", { tags: ["label"] }],
  where: { done: false, or: [{ priority: ["gte", 3] }, { pinned: true }] },
  order: [{ column: "created", desc: true }],
  limit: 10,
});

// the caller is the second argument, exactly like handle(request, ctx)
await pgRest.query(
  { table: "todos", action: "insert", rows: { title: "Write docs" }, select: ["id"] },
  { role: "authenticated", claims: { sub: user.id } },
);
```

**It is the same code path**, not a second implementation: the object is turned into the query parameters PostgREST would
have parsed, and from there everything is shared — `select` trees, the 25 filter operators, embedding, `set_config` of the
role and claims (so RLS applies), the SQL builders, the SQLSTATE mapping. `tests/query.test.ts` asserts that `query()` and
`handle()` answer with the same thing, down to the error bodies. What you gain over building a URL yourself is that the
query string, the `Request`, the headers and the response parsing all disappear — and that the input can be typed.

| field                                   | meaning                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `table` / `rpc`                         | the relation to read or write, or the function to call                                               |
| `action`                                | `select` (default), `insert`, `upsert`, `update`, `delete`                                           |
| `select`                                | columns; `{ relation: [...] }` embeds, with `{ inner, hint, as, spread, where, order, limit }`        |
| `where`                                 | `{ col: value }` (eq), `{ col: ["gte", 3] }`, `{ col: { op, value, not, quantifier, config } }`, `and`/`or` groups |
| `order`, `limit`, `offset`              | paging; a dotted key or an embed option does the same for an embedded resource                        |
| `single`                                | one object instead of an array (406 `PGRST116` otherwise)                                             |
| `count`                                 | `exact` / `planned` / `estimated`, returned as `count`                                                |
| `rows` / `set` / `args`                 | the payload of an insert or upsert, of an update, and the arguments of a function                     |
| `returning`                             | `representation` (the default here) or `minimal`                                                      |
| `schema`, `stripNulls`, `maxAffected`, `timezone` | the `Accept-Profile`, `nulls=stripped` and `Prefer` equivalents                             |

It returns `{ data, count, status }`: the rows (or the object, or `null`), the total when you asked for a `count`, and the
status the same call would have answered over HTTP — handy for `201` after an insert.

Two deliberate differences from the HTTP default, both documented and both reversible: a write **returns its rows** unless you
pass `returning: "minimal"` (a function that gives nothing back is of little use in a program), and a function call is always a
`POST` (so its transaction is read-write, even for a `STABLE` function).

Errors **throw** instead of becoming a response:

```ts
try {
  await pgRest.query({ table: "cients" });
} catch (e) {
  if (e instanceof QueryError) {
    e.status; // 404
    e.body; // { code: "PGRST205", message: "Could not find the table 'api.cients'…", details: null, hint: "Perhaps you meant the table 'api.clients'" }
    e.input; // the object you passed, so you can see what failed
  }
}
```

`QueryError` extends `ApiError`, which extends `Error`: the PostgREST body is untouched (same `code` to switch on as your
HTTP clients get), while `Error.message` is a one-line summary with the code and hint for your logs. An unexpected internal
error keeps its stack under `cause`.

If you would rather handle the failure as a value than with `try/catch`, `querySafe()` is the same query with the error
returned instead of thrown:

```ts
const { data, error } = await pgRest.querySafe({ table: "cients" });
if (error) return c.json(error.body, error.status); // the PostgREST body, straight through
data; // non-null here: exactly one of the two is set, and TypeScript knows it
```

It returns `{ data, error, count, status }` and nothing else differs — same `QueryError`, same codes, same everything.
**`querySafe()` never rejects**: an error the library did not foresee comes back as a 500 `error` with the original under
`cause`, so checking `error` is all a caller ever has to do. `query()` is unchanged; pick one per call site.

Content negotiation is the part that cannot leave HTTP: CSV, GeoJSON, custom media type handlers, `EXPLAIN` plans, `Range`
headers, `OPTIONS` and the OpenAPI document stay on `handle()`. Reads, writes, RPC and RLS are all here.

### Generated types

`schemaCache()` is the introspected catalog — the very thing the request path reads to decide what a query may do. So the
types come from there, and what they allow is what the library accepts:

```ts
// scripts/gen-types.ts — run it after a migration
import { writeFileSync } from "node:fs";
import { generateTypes } from "@adrdp/pg-rest/types";

writeFileSync("src/db.types.ts", generateTypes(await pgRest.schemaCache(), { name: "DatabasePgRest" }));
```

No CLI and no second database connection: you already have a driver, and the library has no runtime dependency to spend
on one. The output is a plain module with no imports — commit it, and add it to your formatter's ignore list so the file
stays byte-for-byte what the generator produced.

```ts
type DatabasePgRestApiRelations = {
  todos: {
    row: { id: number; title: string; done: boolean; created: string; owner_id: string | null };
    insert: { id?: number; title: string; done?: boolean; created?: string; owner_id?: string | null };
    update: { id?: number; title?: string; done?: boolean; created?: string; owner_id?: string | null };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: { tags: { rel: "tags"; to: "many" } };
  };
  // …
};

type DatabasePgRestApiFunctions = {
  open_todos: [{ args: {}; returns: DatabasePgRestApiRelations["todos"]["row"]; set: true }];
};

export type DatabasePgRest = {
  default: "api";
  schemas: { api: { relations: DatabasePgRestApiRelations; functions: DatabasePgRestApiFunctions } };
};
```

What ends up in there:

| | |
| --- | --- |
| `row` / `insert` / `update` | `insert` leaves out generated columns and makes a column optional when it has a default or is nullable; a relation that cannot be written gets `never` |
| enums | the labels, as a union — `"sad" \| "ok" \| "happy"`, and `("sad" \| "ok")[]` for an array of them |
| `rel` | every name you may embed, resolved by `findRelationships`, **the same function the request path uses** — so a `select` the types accept is one the library can resolve. `to: "one" \| "many"` distinguishes an object from an array, and an ambiguous pair carries `hints` (the request needs one, `PGRST201`) |
| `functions` | arguments with their optionality, overloads as a tuple, and the result: a relation's `row`, a scalar, `null` for `void` |
| every exposed schema | `default` is the first one |

And what it cannot know, deliberately reported as `unknown` rather than as a plausible `string`: `json`/`jsonb`, domains,
composites, PostGIS and anything else unrecognised. Two more honest gaps: a view column is typed `| null` because the
catalog says so of every view column (a `NOT NULL` source says nothing about a `LEFT JOIN` in the view's own query —
`views: "like-source"` follows the source column instead, if you know your views), and a `TABLE(...)` function returns
`Record<string, unknown>` because the catalog does not carry its output columns, which is exactly how much the request
path knows too.

### A typed instance

Hand the generated type to `createPgRest` and the queries check themselves:

```ts
const pgRest = await createPgRest<DatabasePgRest>({ db: nodePostgresAdapter(pool), schemas: ["api"] });

const { data } = await pgRest.query({
  table: "todos", //                        only a relation that exists
  select: ["id", "title", { tags: ["label"] }], //  only real columns and real relationships
  where: { done: false }, //                only its own columns, with the right value type
  order: [{ column: "created", desc: true }],
  limit: 10,
});
// data: Array<{ id: number; title: string; tags: Array<{ label: string }> }>
```

`data` is inferred from the `select`, down to the nesting: a to-one embed is an object or `null` (not null with
`inner: true`), a to-many embed is an array, `as` renames the key, `spread` merges the columns into the parent row — and
turns each of them into an array when it spreads a to-many. `single: true` returns the object alone,
`returning: "minimal"` returns `null`, a function's arguments and result come from its signature, overloads included, and
a misspelled field that the runtime would silently drop is refused.

**The table restricts the columns in your editor too**, not only when the compiler runs: inside `select` on `tags`, the
completion offers that table's three columns and nothing from `todos`. That is not free — TypeScript narrows the
contextual type of a nested property only when the discriminant picks exactly one member of the union, so the query type
keeps one member per table (reads and writes merged, each action's payload required by `WriteRules`) and every member
declares `table`, function calls included (`table?: never`). `tests/completions.test.ts` asks the language service and
pins the answer, because both are easy to undo by accident.

The type argument goes on `createPgRest`, not on the call: TypeScript stops inferring the remaining type arguments as
soon as one is given explicitly, so `query<DatabasePgRest>({ … })` would check the input and then hand you `unknown`.

**The types describe the schema, not the caller.** `insertable` and its two siblings come from
`pg_relation_is_updatable`, which is structural -- an aggregate view can never be written, whoever asks -- and say
nothing about `GRANT`. An insert as `anon` therefore compiles, and Postgres answers `42501` → 401, which is the point:
the role is chosen per call (usually from a cookie, so the compiler never sees it), one schema serves every role, and row
level security is a predicate over rows that no type can express. Privileges and RLS stay where they are enforced.

What the typed path does not describe, because the type would have to lie: casts (`total::text`), JSON paths
(`meta->>tier`) and aggregates (`total.sum()`). They change or invent a column, and reading that back out of a string
literal costs more than it gives. `createPgRest(options)` without a type argument is unchanged — same loose input, and
`query<Todo[]>(…)` to name the result yourself — so an untyped instance remains the escape hatch, and `handle` is
untouched either way: an HTTP request is a string from outside.

## Examples

Self-contained projects in [`examples/`](examples) (a todo API with Row Level Security; each has its own README, schema and `server.ts`):

| example                                             | runtime         | driver                                                 | needs a database server       |
| --------------------------------------------------- | --------------- | ------------------------------------------------------ | ----------------------------- |
| [`with-bun`](examples/with-bun)                     | Bun             | `Bun.sql` (built in)                                   | yes (docker-compose included) |
| [`with-node-postgres`](examples/with-node-postgres) | Node.js ≥ 22.18 | `pg`                                                   | yes (docker-compose included) |
| [`with-postgres-js`](examples/with-postgres-js)     | Node.js ≥ 22.18 | `postgres`                                             | yes (docker-compose included) |
| [`with-pglite`](examples/with-pglite)               | Node.js ≥ 22.18 | `@electric-sql/pglite`                                 | no (Postgres in WebAssembly)  |
| [`with-better-auth`](examples/with-better-auth)     | Node.js ≥ 22.18 | `pg` + [Better Auth](https://better-auth.com) sessions | yes (docker-compose included) |

And one that is not a server at all: [`with-generated-types`](examples/with-generated-types) — two tables, an enum, and
typed queries checked against types generated from the database (`npm run gen:types && npm start`). It runs on PGlite, so
there is nothing to install or start.

## Database adapters

`db` is a `DbAdapter` — the only thing pg-rest needs from a driver:

```ts
interface DbAdapter {
  query(text: string, params?: (string | null)[]): Promise<Record<string, unknown>[]>;
  transaction<A>(fn: (session: { query: DbAdapter["query"] }) => Promise<A>): Promise<A>; // one connection, BEGIN/COMMIT/ROLLBACK
  close?(): Promise<void>;
}
```

| import                                                                | wraps                       | peer dependency        |
| --------------------------------------------------------------------- | --------------------------- | ---------------------- |
| `@adrdp/pg-rest/adapters/bun` → `bunSqlAdapter(sql)`                  | `new SQL(url)` from `"bun"` | none (built into Bun)  |
| `@adrdp/pg-rest/adapters/node-postgres` → `nodePostgresAdapter(pool)` | `new pg.Pool(...)`          | `pg` ≥ 8               |
| `@adrdp/pg-rest/adapters/postgres-js` → `postgresJsAdapter(sql)`      | `postgres(url)`             | `postgres` ≥ 3         |
| `@adrdp/pg-rest/adapters/pglite` → `pgliteAdapter(db)`                | `new PGlite()`              | `@electric-sql/pglite` |

The adapters are structural (they never import the driver; you pass the client in), so a project only loads the code it imports.
To support another driver, implement the interface above (about 20 lines) — the adapter sources in `src/adapters` are good templates.

Parameters are always text with an explicit `$n::text` cast in the SQL, so no type inference is needed. Database errors are recognised
by SQLSTATE (`code`, `errno` or `sqlState` on the thrown error), so adapters don't have to translate them. pg-rest never closes your
driver; `pgRest.close()` only stops the handler.

In SQL, policies read the same GUCs as with PostgREST:

```sql
CREATE POLICY own ON api.notes USING (owner = (current_setting('request.jwt.claims', true)::json ->> 'sub'));
```

## Performance

[`bench/`](bench) load-tests pg-rest against the real PostgREST 16 on the same database, data and pool size, after checking that both return identical
results. In a small 2-vCPU sandbox pg-rest on Bun was on par with or faster than PostgREST in every scenario, and slower on a few of the cheapest ones
when run on Node (it also uses more memory); the benchmark includes `bun build --compile`, `--bytecode` and `bun compile` variants; see [`bench/README.md`](bench/README.md) for the numbers, the caveats and how to run it on your own hardware.

### Which runtime?

Numbers from one run on a small 2-vCPU sandbox (indicative only; see the benchmark README). Throughput is relative to PostgREST 16.

|              | Bun (`bun run`)                       | Bun, compiled (`bun compile`, experimental)                              | Node + `pg`                                             |
| ------------ | ------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| Throughput   | 1.2–1.5× on most reads, ~2× on writes | same as plain Bun (within noise)                                         | 0.7–0.9× on the cheapest queries, ahead on heavier ones |
| Peak memory  | ~80 MB                                | ~50 MB                                                                   | ~125 MB                                                 |
| Setup        | nothing extra                         | single executable; needs a recent (canary) Bun                           | Node (tested on 22)                                     |
| Pick it when | you can run Bun (default choice)      | memory or deployment size matters and you accept an experimental feature | Bun is not an option                                    |

`bun build --compile` and `--bytecode` performed like plain Bun, so they are only worth it if you want a single binary. PostgREST itself uses the least memory (about 40–47 MB).

## Options

| option                | meaning                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `db`                  | a `DbAdapter` built from your driver (see [Database adapters](#database-adapters))                        |
| `schemas`             | exposed schemas; selected with `Accept-Profile` / `Content-Profile`                                       |
| `anonymousRole`       | role when no context is resolved (`PGRST302` if unset and none given); `false` refuses anonymous requests |
| `planEnabled`         | allow `Accept: application/vnd.pgrst.plan` (EXPLAIN output); off by default, like `db-plan-enabled`       |
| `resolveContext(req)` | return `{ role, claims, settings }`; throw `PgRestError` to reject (e.g. 401)                             |
| `handle(req, ctx?)`   | an explicit context overrides `resolveContext`                                                            |
| `maxRows`             | cap on rows returned                                                                                      |
| `basePath`            | URL prefix to strip                                                                                       |
| `extraSearchPath`     | extra schemas appended to `search_path`                                                                   |
| `requestSettings`     | set `request.method/path/headers/cookies` GUCs (default on)                                               |
| `preRequest`          | SQL function name or `(session, info) => void`, run inside the request transaction                        |
| `allowTxOverride`     | honour `Prefer: tx=rollback`                                                                              |
| `openApi`             | serve the Swagger 2.0 document at `/`                                                                     |

Also returned: `query(input, ctx?)` (see [In-process queries](#in-process-queries)), `reloadSchema()` (call after migrations),
`schemaCache()`, `close()`.

## Supported

Reads with embedding (m2o, o2m, o2o, m2m, aliases, hints, `!inner`, spread of to-one, nested, filters/order/limit on embeds),
all filter operators and `and/or/not`, JSON paths, casts, aggregates, ordering, `Range`/`limit`/`offset`,
spread of to-many, order by related column, embedding through views and computed relationships, aggregates in embeds,
`Prefer: count=exact|planned|estimated`, inserts (bulk, `columns`, `missing=default`), upsert, PATCH, PUT, DELETE,
`return=` / `handling=` / `max-affected` / `timezone` / `tx`, RPC (GET/POST, overloads, `VARIADIC`, bulk calls, set/scalar/void, unnamed json arg,
response GUC headers/status), CSV / singular / `nulls=stripped` / plan representations, custom media type handlers (domains and aggregates named after a media type), `application/geo+json` (with PostGIS), `WWW-Authenticate` on 401, OpenAPI, PostgREST error codes
and `PTxyz` / `RAISE ... SQLSTATE 'PGRST'` conventions.

## Not supported

Two different things are listed here. Don't confuse them.

### By design: will not be implemented

pg-rest is a library, not a server. Anything whose job is to run the process, authenticate the caller, or configure PostgREST from outside the
code is handled by _your_ application instead. These are not gaps: adding them would work against the goals of the project.

| PostgREST feature                                                                                                      | Why pg-rest doesn't do it                                                                                                                                                                                                                                   | What to do instead                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JWT validation, JWKS, `jwt-secret`, audience, role claim path                                                          | The point of the project is that **you** decide who the caller is, by any means: a session cookie, an API key, Better Auth, mTLS. Baking JWT in would force one scheme and add crypto and key-rotation code (and dependencies) to the library.              | `resolveContext(req)` or `handle(req, ctx)` returns `{ role, claims, settings }`. pg-rest applies it with `set_config`, so RLS and `current_setting('request.jwt.claims')` work as usual. See `examples/with-better-auth`. |
| Standalone server, CLI, host/port, unix sockets, TLS, `log-level`, `server-timing`                                     | `handle(Request) => Response` is web-standard and runs under `Bun.serve`, Hono (`@hono/node-server`), or any framework that gives you a `Request`... Owning the server would tie the library to one runtime and duplicate what your framework already does. | Mount `handle` in your own server.                                                                                                                                                                                         |
| Admin server (`/live`, `/ready`, `/metrics`)                                                                           | Health checks and metrics belong to the host process.                                                                                                                                                                                                       | Expose them in your app.                                                                                                                                                                                                   |
| CORS headers                                                                                                           | Policy depends on your deployment.                                                                                                                                                                                                                          | Set them in your server or middleware.                                                                                                                                                                                     |
| Config file, environment variables, `PGRST_*` settings                                                                 | Configuration is the `createPgRest(options)` call, which is typed and lives with the code.                                                                                                                                                                  | Pass options; read env vars yourself.                                                                                                                                                                                      |
| Connection pool and `db-uri`                                                                                           | The pool belongs to your driver, and the driver is your choice (`DbAdapter`). pg-rest never opens connections.                                                                                                                                              | Create the pool, wrap it in an adapter.                                                                                                                                                                                    |
| In-database configuration (`db-pre-config`, per-role `ALTER ROLE ... SET pgrst.*`)                                     | Settings are options in code, not rows in the database, so they are versioned and visible with the application.                                                                                                                                             | Use the options; `preRequest` can still call a SQL function if you want database-side logic.                                                                                                                               |
| Schema cache refresh over SQL: `NOTIFY pgrst, 'reload schema'` / `db-channel`, `SIGUSR1`/`SIGUSR2`, DDL event triggers | They require a dedicated `LISTEN` connection and signal handling, which a library must not hold open or assume (serverless, PGlite and pooled connections can't `LISTEN`). The introspection itself (`pg_catalog`) is implemented.                          | Call `reloadSchema()` after migrations, or wire it to your own `LISTEN`. A failed reload keeps the old cache.                                                                                                              |

## Security notes

Request values are never concatenated raw: values become escaped literals or `$n::text` parameters, identifiers are quoted,
cast targets must match a strict type allowlist, GUC names must be dotted. See `tests/security.test.ts`.

## Development

`mise.toml` pins the PostgREST binary the differential test needs and runs a throwaway Postgres 16 **with PostGIS**
(required: the `application/geo+json` cases fail without it). Nothing is installed system-wide.

```sh
bun install
mise install        # PostgREST 16.5, the official static release
mise run db:start   # Postgres 16 + PostGIS under .cache/ (also db:stop, db:reset)
mise run test       # the whole suite, differential and GeoJSON cases included
```

Or bring your own Postgres 16 and PostgREST:

```sh
TEST_DATABASE_URL=postgres://user@host:5432/postgres bun test   # a server you can create databases on
POSTGREST_BIN=/path/to/postgrest TEST_DATABASE_URL=... bun run test:compare   # see PARITY.md
bun run typecheck && bun run build

# run an example end to end; the second argument is a database URL with the schema loaded
scripts/check-example.sh with-node-postgres postgres://user@host:5432/mydb
```

The examples depend on `pg-rest` by version, so use `bun run link:examples [name]` to point them at the local
build; `bun run check:examples` asserts they match the root `package.json`.
