# tsql

Two packages for talking to PostgreSQL from your own process, built on one core:

| package | what it is |
| --- | --- |
| **`@tsql/rest`** | **PostgREST v16, as a library.** `handle(Request) => Promise<Response>`, identical to PostgREST: nothing added, nothing taken away |
| **`@tsql/query`** | **The same engine without HTTP.** `select()`, `insert()`, `update()`... from an object, typed from your schema, with `$` filters and computed updates PostgREST does not have |

They share the parser, the SQL, the schema cache, the errors and the adapters (each package bundles that core, so there is
nothing else to install). Use either, or both.

## `@tsql/rest`

**PostgREST v16, as a library.** The same URLs, the same negotiation, the same JSON, the same status codes and the same
`PGRSTxxx` error bodies — as a web-standard `handle(Request) => Promise<Response>` you mount in your own server.

Measured, not promised: every run replays **344 requests against the real PostgREST 16.5 binary** and compares status,
headers and body. One difference is accepted today, and asserted so it cannot quietly become two →
[`PARITY.md`](PARITY.md).

Being a library is the rest of it. **No JWT and no server:** you decide who the caller is — cookie, API key, session,
mTLS — and hand over a role and claims, applied with `set_config` so Row Level Security sees what it would behind
PostgREST. And no runtime dependencies, nothing but web standards in the core, your driver staying yours.

> **Not an ORM:** there is no model of your database here to drift from it. The types are read out of the catalog, one
> way, and the query language stays PostgREST's.
> → [the line none of these may cross](docs/proposals.md#the-line-none-of-these-may-cross)

```sh
npm i @tsql/rest pg      # or: bun add @tsql/rest (Bun.sql is built in), postgres, @electric-sql/pglite
```

### Over HTTP

```ts
import pg from "pg";
import { createRest } from "@tsql/rest";
import { nodePostgresAdapter } from "@tsql/rest/adapters/node-postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rest = await createRest({
  db: nodePostgresAdapter(pool), // you create and close the driver
  schemas: ["api"], //             the first one is the default schema
  anonymousRole: "anon",
  resolveContext: async (req) => {
    const user = await mySessionLookup(req); // your auth, by any means
    return user ? { role: "authenticated", claims: { sub: user.id } } : undefined;
  },
});

// any host that speaks Request/Response:
// Bun:
Bun.serve({ fetch: (req) => rest.handle(req) });

// Node:
serve({ fetch: (req) => rest.handle(req) }); // @hono/node-server

// Hono:
app.all("/api/*", (c) => rest.handle(c.req.raw));
```

```sh
curl 'localhost:3000/todos?select=id,title,tags(label)&done=is.false&order=priority.desc&limit=10'
```

Any PostgREST client works — the wire format is the whole contract. Including
[`@supabase/postgrest-js`](https://github.com/supabase/supabase-js/tree/master/packages/core/postgrest-js) and
[`@neondatabase/postgrest-js`](https://github.com/neondatabase/neon-js/tree/main/packages/postgrest-js).

## `@tsql/query`

```sh
npm i @tsql/query pg
```

```ts
import { createQuery } from "@tsql/query";
import { nodePostgresAdapter } from "@tsql/query/adapters/node-postgres";
import { schema } from "./db.generated"; // written at build time: see below

const pgRest = createQuery({ db: nodePostgresAdapter(pool), schema });
```

### In the same process, with types from your schema

No HTTP, no loopback call: the same parser, the same SQL and the same `set_config` of the role and claims, so Row Level
Security applies as it would over the wire. If you know `postgrest-js`, the operations take the same shape of request —
without the server on the other end: no second process to run, and the pool stays yours.

```ts
const { data, error } = await pgRest.select(
  {
    table: "todos",
    columns: ["id", "title", { tags: ["label"] }],
    where: { done: false },
    order: [{ column: "priority", desc: true }],
    limit: 10,
  },
  { role: "authenticated", claims: { sub: user.id } },
);
if (error) throw error; // or switch on `error.kind` and answer as your framework does
// data is narrowed from here on: Array<{ id: number; title: string; tags: Array<{ label: string }> }>
```

A failure is part of the result: `error` is a `QueryError` carrying the `message`, `details`, `hint`, the `sqlState` of a database error, a `summary` written
out for whoever reads it, and a `kind` — `"conflict"`, `"not_single_row"`, `"forbidden"`… — which is a string union, so
a `switch` on it is checked by the compiler instead of against a table of error codes. The operations never reject.

Two writes that must land together get one transaction, with the context applied once for all of it:

```ts
const { data, error } = await pgRest.transaction(async (tx) => {
  const todo = await tx.insert({ table: "todos", rows: { title: "ship it" }, single: true });
  await tx.insert({ table: "tags", rows: { todo_id: todo.data.id, label: "release" } });
  return todo.data.id;
}, { role: "authenticated", claims: { sub: user.id } });
```

Inside a scope a query that fails leaves it, so the transaction rolls back and `data` needs no narrowing — the promise
that never rejects is the scope's. `tx.transaction()`, a savepoint, is how one query is *allowed* to fail.

→ [`docs/query.md`](docs/query.md)

One build-time call reads the catalog and writes the types and the schema `createQuery` runs on, and one type
argument puts the types to work. A running server never reads the catalog, and checks nothing at runtime: the compiler
is what keeps a query and the schema in step.

```ts
writeFileSync("src/db.generated.ts", generateModule(await introspect(nodePostgresAdapter(pool), ["api"]), { name: "Database" }));
```

```ts
const pgRest = createQuery<Database>({ db: nodePostgresAdapter(pool), schema });

const { data, count, error } = await pgRest.select({
  table: "todos", //                             only a relation that exists
  columns: ["id", "title", { tags: ["label"] }], //  only real columns and relationships
  where: { done: false }, //                     only its own columns, with the right value type
  order: [{ column: "priority", desc: true }], //  a column again: a typo is an error, not a silently unordered answer
  limit: 10, //                                  plain numbers: limit, offset
  count: "exact", //                             asked for, so `count` is a number -- and `undefined` without this line
});
if (error) throw error;
// data: Array<{ id: number; title: string; tags: Array<{ label: string }> }>, count: number
```

They come from the catalog the library itself reads, so what they allow is what it accepts — down to your enums, the
fields of your composite types, and which embeds a foreign key actually permits. → [`docs/types.md`](docs/types.md)

## Documentation

|                                                |                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| [`docs/query.md`](docs/query.md)               | the operations, with an example for every field                   |
| [`docs/types.md`](docs/types.md)               | generating types, the typed instance, and what it cannot describe |
| [`docs/options.md`](docs/options.md)           | every `createRest` and `createQuery` option, and what they give back |
| [`docs/adapters.md`](docs/adapters.md)         | `DbAdapter`, the four that ship, and writing your own             |
| [`docs/design.md`](docs/design.md)             | what it does, and what it will never do because it is a library   |
| [`docs/architecture.md`](docs/architecture.md) | how a request becomes SQL, and where each piece lives             |
| [`docs/security.md`](docs/security.md)         | the role and RLS model, and how request values reach SQL          |
| [`docs/performance.md`](docs/performance.md)   | measured against PostgREST 16, and which runtime to pick          |
| [`docs/development.md`](docs/development.md)   | running the tests, the examples and the differential suite        |
| [`docs/proposals.md`](docs/proposals.md)       | the additions under consideration, and what each would cost       |
| [`PARITY.md`](PARITY.md)                       | PostgREST v16 feature by feature                                  |

## Examples

Self-contained projects in [`examples/`](examples), one folder per package. Each has its own README, schema and scripts.

**[`examples/rest`](examples/rest)** — `@tsql/rest`: a todo API with Row Level Security, one per driver, each with a `server.ts`:

| example                                                      | runtime         | driver                                        | needs a database server       |
| ------------------------------------------------------------ | --------------- | --------------------------------------------- | ----------------------------- |
| [`with-bun`](examples/rest/with-bun)                         | Bun             | `Bun.sql` (built in)                          | yes (docker-compose included) |
| [`with-node-postgres`](examples/rest/with-node-postgres)     | Node.js ≥ 22.18 | `pg`                                          | yes (docker-compose included) |
| [`with-postgres-js`](examples/rest/with-postgres-js)         | Node.js ≥ 22.18 | `postgres`                                    | yes (docker-compose included) |
| [`with-pglite`](examples/rest/with-pglite)                   | Node.js ≥ 22.18 | `@electric-sql/pglite`                        | no (Postgres in WebAssembly)  |
| [`with-better-auth`](examples/rest/with-better-auth)         | Node.js ≥ 22.18 | `pg` + [Better Auth](https://better-auth.com) | yes (docker-compose included) |

**[`examples/query`](examples/query)** — `@tsql/query`: no server, no HTTP:

| example                                                      | runtime | driver                 | needs a database server   |
| ------------------------------------------------------------ | ------- | ---------------------- | ------------------------- |
| [`with-generated-types`](examples/query/with-generated-types) | Bun     | `@electric-sql/pglite` | no — and no server either |
| [`with-transactions`](examples/query/with-transactions)       | Bun     | `@electric-sql/pglite` | no — and no server either |

[`with-generated-types`](examples/query/with-generated-types) is the shortest way to see the typed path: two tables, an enum,
a composite type, `bun run gen:types && bun start`. [`with-transactions`](examples/query/with-transactions) is the other
library-only one: money moving between two accounts, with the caller read from an `AsyncLocalStorage`.

## Development

```sh
bun install
mise install        # PostgREST 16.5 for the differential test, and micromamba
mise run db:start   # a throwaway Postgres 16 + PostGIS under .cache/
mise run test       # the whole suite
```

→ [`docs/development.md`](docs/development.md) for bringing your own Postgres, running one example end to end, and what
each suite covers.
