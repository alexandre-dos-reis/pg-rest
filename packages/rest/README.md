# @tspg/rest

**PostgREST as a library.** The same behaviour, as a web-standard `handle(Request) => Promise<Response>` you mount in your own server.

One difference is accepted today → see [`PARITY.md`](https://github.com/alexandre-dos-reis/tspg/blob/main/packages/rest/PARITY.md).

**No JWT:** you decide who the caller is — cookie, API key, session, mTLS — and hand over a role and
claims, applied with `set_config` so Row Level Security sees what it would behind PostgREST. No runtime dependencies, and your driver stays yours.

```sh
npm i @tspg/rest pg
yarn add @tspg/rest pg
pnpm i @tspg/rest pg
bun add @tspg/rest # Bun.sql is built in
```

We also support other adapters, like PGlite and node-postgres.

```ts
import pg from "pg";
import { createRest } from "@tspg/rest";
import { nodePostgresAdapter } from "@tspg/rest/adapters/node-postgres";

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

Bun.serve({ fetch: (req) => rest.handle(req) });
// or @hono/node-server, or Hono, or any Request/Response host
```

```sh
curl 'localhost:3000/todos?select=id,title,tags(label)&done=is.false&order=priority.desc&limit=10'
```

Any PostgREST client works — the wire format is the whole contract, including `@supabase/postgrest-js` and
`@neondatabase/postgrest-js`.

> **Not an ORM:** there is no model of your database here to drift from it. The types are read out of the catalog, one way, and the query language stays PostgREST's.

## Documentation

- [every `createRest` option](https://github.com/alexandre-dos-reis/tspg/blob/main/docs/options.md)
- [the adapters, and writing your own](https://github.com/alexandre-dos-reis/tspg/blob/main/docs/adapters.md)
- [the role and RLS model](https://github.com/alexandre-dos-reis/tspg/blob/main/docs/security.md)
- [PostgREST v16, feature by feature](https://github.com/alexandre-dos-reis/tspg/blob/main/packages/rest/PARITY.md)
- [runnable examples, one per driver](https://github.com/alexandre-dos-reis/tspg/tree/main/examples/rest)
