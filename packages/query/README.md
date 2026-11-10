# @tspg/query

**Typed queries that respect your PostgreSQL schema.** `select()`, `insert()`, `update()`,
`delete()` and `rpc()`.

The types come out of your own catalog: only a relation that exists, only its real columns and the embeds a foreign key permits, with the right value type — down to your enums and the fields of your composite types. A role and claims are applied with `set_config`, so Row Level Security decides what a caller may see.

```sh
npm i @tspg/query pg
yarn add @tspg/query pg
pnpm i @tspg/query pg
bun add @tspg/query # Bun.sql is built in
```

We also support other postgres adapters, like PGlite and postgres-js.

```ts
import pg from "pg";
import { createQuery } from "@tspg/query";
import { nodePostgresAdapter } from "@tspg/query/adapters/node-postgres";
import type { Database } from "./db.generated"; // written at build time: see below

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// the driver, the schemas to expose, and the generated type: nothing else is needed
const db = createQuery<Database>({ db: nodePostgresAdapter(pool), schemas: ["api"] });

const { data, error } = await db.select(
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
// data: Array<{ id: number; title: string; tags: Array<{ label: string }> }>
```

A filter is written with `$`-prefixed operators — `{ total: { $gte: 100, $lt: 500 } }`, `{ $not: { $in: [1, 2] } }` —
and which ones a column accepts follows its type: `$like` on text, `$cs` on arrays, `$gt` on ordered types.

Two writes that must land together get one transaction, with the context applied once for all of it:

```ts
const { data, error } = await db.transaction(
  async (tx) => {
    const todo = await tx.insert({ table: "todos", rows: { title: "ship it" } });
    await tx.insert({ table: "tags", rows: { todo_id: todo.data.id, label: "release" } });
    return todo.data.id;
  },
  { role: "authenticated", claims: { sub: user.id } },
);
```

Inside a scope a query that fails leaves it, so the transaction rolls back and `data` needs no narrowing. `tx.transaction()`,
a savepoint, is how one query is _allowed_ to fail.

## Types from your schema

One build-time call, on the same options the instance is created from, reads the catalog and writes the types. Run it
again after a migration and commit the file, like any other generated artefact:

```ts
import { generateTypes } from "@tspg/query/types";

// options is what createQuery takes: { db: nodePostgresAdapter(pool), schemas: ["api"] }
writeFileSync("src/db.generated.ts", await generateTypes(options, { name: "Database" }));
```

Nothing is checked at runtime: the compiler is what keeps a query and the schema in step. The instance reads the catalog
itself, once, on its first query — `await db.ready()` does it at start-up instead, so a connection or catalog problem
surfaces there.

To read the catalog **never**, use `generateModule` instead: it writes the same types plus a `schema` descriptor of the
catalog, and an instance given that descriptor needs no round trip and no catalog permissions, which is what a cold
start on a serverless runtime wants:

```ts
import { schema, type Database } from "./db.generated";

const db = createQuery<Database>({ db: nodePostgresAdapter(pool), schema });
```

## Documentation

- [the operations, with an example for every field](https://github.com/alexandre-dos-reis/tspg/blob/main/docs/query.md)
- [generating types, and what they cannot describe](https://github.com/alexandre-dos-reis/tspg/blob/main/docs/types.md)
- [every `createQuery` option](https://github.com/alexandre-dos-reis/tspg/blob/main/docs/options.md)
- [the adapters, and writing your own](https://github.com/alexandre-dos-reis/tspg/blob/main/docs/adapters.md)
- [runnable examples](https://github.com/alexandre-dos-reis/tspg/tree/main/examples/query)

MIT
