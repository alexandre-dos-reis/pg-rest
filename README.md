# pg-rest

**PostgREST v16, as a library.** The same URL grammar, the same embedding, the same `Prefer` / `Accept` / `Range`
negotiation, the same JSON shapes, the same status codes and the same `PGRSTxxx` error bodies — delivered as a
web-standard `handle(Request) => Promise<Response>` that you mount in your own server, on top of a tiny
database-adapter interface.

Compatibility here is a measurement, not a promise: every run replays **344 requests against the real PostgREST 16.5
binary**, on the same database with the same data, and compares status, headers and body. Exactly **one** difference is
accepted today — pg-rest refuses a cast target that is not a plain type name — and the test asserts that it still
differs, so it cannot quietly become two. [`PARITY.md`](PARITY.md) is the table, feature by feature, and marks what is
out of scope on purpose.

What being a library changes:

- **Runtime-agnostic.** Only web standards (`Request`/`Response`/`Headers`), no driver and no runtime API of its own.
  Tested on Bun and Node.js 22; no runtime dependencies.
- **Bring your own driver.** Bun.sql, node-postgres, postgres.js and PGlite adapters ship as separate entry points; the
  drivers are optional peer dependencies.
- **No JWT and no server.** You decide who the caller is — cookie, API key, session, mTLS — and hand over a role and
  claims, applied per request with `set_config`, so Row Level Security sees what it would behind PostgREST.
- **Callable without HTTP.** `query({ table: "todos", select: ["id"] })` runs in the calling process, through the same
  parser, the same SQL and the same errors. A server cannot offer that.

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
//   Bun:  Bun.serve({ fetch: (req) => pgRest.handle(req) })
//   Node: serve({ fetch: (req) => pgRest.handle(req) })    // @hono/node-server
//   Hono: app.all("/api/*", (c) => pgRest.handle(c.req.raw))
```

```sh
curl 'localhost:3000/todos?select=id,title,tags(label)&done=is.false&order=priority.desc&limit=10'
```

## In the same process, with types from your schema

No HTTP, no loopback call: the same parser, the same SQL and the same `set_config` of the role and claims, so Row Level
Security applies as it would over the wire.

```ts
const { data } = await pgRest.query({
  table: "todos",
  select: ["id", "title", { tags: ["label"] }],
  where: { done: false },
  order: [{ column: "priority", desc: true }],
  limit: 10,
}, ctx);
```

Errors throw a `QueryError` carrying the PostgREST status and body; `querySafe()` hands them back as `{ data, error }`
instead. → [`docs/query.md`](docs/query.md)

One command writes the types for your database, and one type argument puts them to work:

```ts
writeFileSync("src/db.types.ts", await pgRest.generateTypes({ name: "Database" }));
```

```ts
const pgRest = await createPgRest<Database>({ db: nodePostgresAdapter(pool), schemas: ["api"] });

const { data } = await pgRest.query({
  table: "todos", //                             only a relation that exists
  select: ["id", "title", { tags: ["label"] }], //  only real columns and relationships
  where: { done: false }, //                     only its own columns, with the right value type
});
// data: Array<{ id: number; title: string; tags: Array<{ label: string }> }>
```

They come from the catalog the library itself reads, so what they allow is what it accepts — down to your enums, and to
which embeds a foreign key actually permits. → [`docs/types.md`](docs/types.md)

## Documentation

| | |
| --- | --- |
| [`docs/query.md`](docs/query.md) | `query()` and `querySafe()`, with an example for every field |
| [`docs/types.md`](docs/types.md) | generating types, the typed instance, and what it cannot describe |
| [`docs/options.md`](docs/options.md) | every `createPgRest` option, and what the instance gives back |
| [`docs/adapters.md`](docs/adapters.md) | `DbAdapter`, the four that ship, and writing your own |
| [`docs/design.md`](docs/design.md) | what it does, and what it will never do because it is a library |
| [`docs/architecture.md`](docs/architecture.md) | how a request becomes SQL, and where each piece lives |
| [`docs/security.md`](docs/security.md) | the role and RLS model, and how request values reach SQL |
| [`docs/performance.md`](docs/performance.md) | measured against PostgREST 16, and which runtime to pick |
| [`docs/development.md`](docs/development.md) | running the tests, the examples and the differential suite |
| [`PARITY.md`](PARITY.md) | PostgREST v16 feature by feature |

## Examples

Self-contained projects in [`examples/`](examples) — a todo API with Row Level Security, one per driver, each with its
own README, schema and `server.ts`:

| example | runtime | driver | needs a database server |
| --- | --- | --- | --- |
| [`with-bun`](examples/with-bun) | Bun | `Bun.sql` (built in) | yes (docker-compose included) |
| [`with-node-postgres`](examples/with-node-postgres) | Node.js ≥ 22.18 | `pg` | yes (docker-compose included) |
| [`with-postgres-js`](examples/with-postgres-js) | Node.js ≥ 22.18 | `postgres` | yes (docker-compose included) |
| [`with-pglite`](examples/with-pglite) | Node.js ≥ 22.18 | `@electric-sql/pglite` | no (Postgres in WebAssembly) |
| [`with-better-auth`](examples/with-better-auth) | Node.js ≥ 22.18 | `pg` + [Better Auth](https://better-auth.com) | yes (docker-compose included) |
| [`with-generated-types`](examples/with-generated-types) | Bun | `@electric-sql/pglite` | no — and no server either |

[`with-generated-types`](examples/with-generated-types) is the shortest way to see the typed path: two tables, an enum,
`bun run gen:types && bun start`.

## Development

```sh
bun install
mise install        # PostgREST 16.5, for the differential test
mise run db:start   # a throwaway Postgres 16 + PostGIS under .cache/
mise run test       # the whole suite
```

→ [`docs/development.md`](docs/development.md) for bringing your own Postgres, running one example end to end, and what
each suite covers.
