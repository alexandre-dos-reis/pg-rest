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

We also support other adapters, like PGlite and node-postgres.

```ts
import pg from "pg";
import { createQuery } from "@tspg/query";
import { nodePostgresAdapter } from "@tspg/query/adapters/node-postgres";
import { schema } from "./db.generated"; // written at build time: see below

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const db = createQuery<Database>({ db: nodePostgresAdapter(pool), schema });

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

One build-time call reads the catalog and writes the types and the schema `createQuery` runs on. A running server never
reads the catalog, and checks nothing at runtime: the compiler is what keeps a query and the schema in step.

```ts
writeFileSync(
  "src/db.generated.ts",
  generateModule(await introspect(nodePostgresAdapter(pool), ["api"]), { name: "Database" }),
);
```

## Documentation

- [the operations, with an example for every field](https://github.com/alexandre-dos-reis/tspg/blob/main/docs/query.md)
- [generating types, and what they cannot describe](https://github.com/alexandre-dos-reis/tspg/blob/main/docs/types.md)
- [every `createQuery` option](https://github.com/alexandre-dos-reis/tspg/blob/main/docs/options.md)
- [the adapters, and writing your own](https://github.com/alexandre-dos-reis/tspg/blob/main/docs/adapters.md)
- [runnable examples](https://github.com/alexandre-dos-reis/tspg/tree/main/examples/query)

MIT
