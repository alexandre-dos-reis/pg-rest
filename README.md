# pg-rest

**PostgREST v16, as a library.** The same URLs, the same negotiation, the same JSON, the same status codes and the same
`PGRSTxxx` error bodies — as a web-standard `handle(Request) => Promise<Response>` you mount in your own server.

Measured, not promised: every run replays **344 requests against the real PostgREST 16.5 binary** and compares status,
headers and body. One difference is accepted today, and asserted so it cannot quietly become two →
[`PARITY.md`](PARITY.md).

Being a library is the rest of it. **No JWT and no server:** you decide who the caller is — cookie, API key, session,
mTLS — and hand over a role and claims, applied with `set_config` so Row Level Security sees what it would behind
PostgREST. **No HTTP needed either:** the same queries run in the calling process, typed from your own schema. And no
runtime dependencies, nothing but web standards in the core, your driver staying yours.

```sh
npm i @adrdp/pg-rest pg      # or: bun add @adrdp/pg-rest (Bun.sql is built in), postgres, @electric-sql/pglite
```

## Over HTTP

```ts
import pg from "pg";
import { createPgRest } from "@adrdp/pg-rest";
import { nodePostgresAdapter } from "@adrdp/pg-rest/adapters/node-postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const pgRest = await createPgRest({
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
Bun.serve({ fetch: (req) => pgRest.handle(req) });

// Node:
serve({ fetch: (req) => pgRest.handle(req) }); // @hono/node-server

// Hono:
app.all("/api/*", (c) => pgRest.handle(c.req.raw));
```

```sh
curl 'localhost:3000/todos?select=id,title,tags(label)&done=is.false&order=priority.desc&limit=10'
```

Any PostgREST client works — the wire format is the whole contract. Including
[`@supabase/postgrest-js`](https://github.com/supabase/supabase-js/tree/master/packages/core/postgrest-js) and
[`@neondatabase/postgrest-js`](https://github.com/neondatabase/neon-js/tree/main/packages/postgrest-js).

## In the same process, with types from your schema

No HTTP, no loopback call: the same parser, the same SQL and the same `set_config` of the role and claims, so Row Level
Security applies as it would over the wire.

```ts
const { data, error } = await pgRest.query(
  {
    table: "todos",
    select: ["id", "title", { tags: ["label"] }],
    where: { done: false },
    order: [{ column: "priority", desc: true }],
    limit: 10,
  },
  { role: "authenticated", claims: { sub: user.id } },
);
if (error) throw error; // or hand `error.body` and `error.status` to your framework
// data is narrowed from here on: Array<{ id: number; title: string; tags: Array<{ label: string }> }>
```

A failure is part of the result: `error` is a `QueryError` carrying the PostgREST status and body, a `summary` written
out for whoever reads it, and a `kind` — `"conflict"`, `"not_single_row"`, `"forbidden"`… — which is a string union, so
a `switch` on it is checked by the compiler instead of against a table of error codes. `query()` never rejects.
→ [`docs/query.md`](docs/query.md)

One command writes the types for your database, and one type argument puts them to work:

```ts
writeFileSync("src/db.types.ts", await pgRest.generateTypes({ name: "Database" }));
```

```ts
const pgRest = await createPgRest<Database>({ db: nodePostgresAdapter(pool), schemas: ["api"] });

const { data, count, error } = await pgRest.query({
  table: "todos", //                             only a relation that exists
  select: ["id", "title", { tags: ["label"] }], //  only real columns and relationships
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
| [`docs/query.md`](docs/query.md)               | `query()`, with an example for every field                        |
| [`docs/types.md`](docs/types.md)               | generating types, the typed instance, and what it cannot describe |
| [`docs/options.md`](docs/options.md)           | every `createPgRest` option, and what the instance gives back     |
| [`docs/adapters.md`](docs/adapters.md)         | `DbAdapter`, the four that ship, and writing your own             |
| [`docs/design.md`](docs/design.md)             | what it does, and what it will never do because it is a library   |
| [`docs/architecture.md`](docs/architecture.md) | how a request becomes SQL, and where each piece lives             |
| [`docs/security.md`](docs/security.md)         | the role and RLS model, and how request values reach SQL          |
| [`docs/performance.md`](docs/performance.md)   | measured against PostgREST 16, and which runtime to pick          |
| [`docs/development.md`](docs/development.md)   | running the tests, the examples and the differential suite        |
| [`docs/proposals.md`](docs/proposals.md)       | four additions under consideration, and what each would cost      |
| [`PARITY.md`](PARITY.md)                       | PostgREST v16 feature by feature                                  |

## Examples

Self-contained projects in [`examples/`](examples) — a todo API with Row Level Security, one per driver, each with its
own README, schema and `server.ts`:

| example                                                 | runtime         | driver                                        | needs a database server       |
| ------------------------------------------------------- | --------------- | --------------------------------------------- | ----------------------------- |
| [`with-bun`](examples/with-bun)                         | Bun             | `Bun.sql` (built in)                          | yes (docker-compose included) |
| [`with-node-postgres`](examples/with-node-postgres)     | Node.js ≥ 22.18 | `pg`                                          | yes (docker-compose included) |
| [`with-postgres-js`](examples/with-postgres-js)         | Node.js ≥ 22.18 | `postgres`                                    | yes (docker-compose included) |
| [`with-pglite`](examples/with-pglite)                   | Node.js ≥ 22.18 | `@electric-sql/pglite`                        | no (Postgres in WebAssembly)  |
| [`with-better-auth`](examples/with-better-auth)         | Node.js ≥ 22.18 | `pg` + [Better Auth](https://better-auth.com) | yes (docker-compose included) |
| [`with-generated-types`](examples/with-generated-types) | Bun             | `@electric-sql/pglite`                        | no — and no server either     |

[`with-generated-types`](examples/with-generated-types) is the shortest way to see the typed path: two tables, an enum,
a composite type, `bun run gen:types && bun start`.

## Development

```sh
bun install
mise install        # PostgREST 16.5, for the differential test
mise run db:start   # a throwaway Postgres 16 + PostGIS under .cache/
mise run test       # the whole suite
```

→ [`docs/development.md`](docs/development.md) for bringing your own Postgres, running one example end to end, and what
each suite covers.
