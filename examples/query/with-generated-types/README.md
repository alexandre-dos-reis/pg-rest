# pg-rest with generated types

The smallest example there is: no server, no HTTP, no auth. Two tables, an enum, a composite type and a function, and
queries that **check themselves** against types generated from the database. This folder is self-contained: copy it anywhere.

```sh
bun install
bun run gen:types   # 1. read the catalog, write db.generated.ts
bun start           # 2. run typed queries
bun run typecheck   # and see that the mistakes in mistakes.ts really are mistakes
```

It runs on **Bun** -- `@types/bun` carries Bun's globals and Node's typings, so one package covers both -- over PGlite,
which keeps the driver in-process. `Bun.sql` and its adapter (see [`with-bun`](../../rest/with-bun)) need a Postgres server
listening somewhere, and this example is about the types, so it stays on the driver that needs nothing started.
Everything here runs the same on Node (`node gen-types.ts`, `node main.ts`) with `@types/node` instead.

Two steps, because that is the real workflow: the types are a file you generate after a migration and commit, like any
other artefact your editor and CI need to see.

`pg-rest` is an ordinary versioned dependency, so once this folder is copied out of the repository the install above is
all you need. Inside the repository that version is not on the registry yet and will not resolve, so link the local
build instead -- from the repository root (never a `file:` or `link:` path in `package.json`, which `check:examples`
refuses, and which installs a partial copy of the repository rather than a link):

```sh
bun run link:examples with-generated-types   # builds pg-rest, then symlinks it into node_modules
```

## The four files

**`db.ts`** -- Postgres in WebAssembly (PGlite), `schema.sql` loaded in memory, and the options. Nothing to install,
nothing to start. It deliberately knows nothing about the generated types: the generator has to run before they exist.

**`gen-types.ts`** -- the generator, which is one call on the instance:

```ts
const types = await pgRest.generateTypes({ name: "DatabasePgRest" });
writeFileSync(new URL("./db.generated.ts", import.meta.url), types);
```

The types come from the catalog the instance already read to answer requests, so they describe exactly what it accepts.
No CLI and no second connection: you already have a driver. This script builds its own *untyped* instance -- a generator
cannot be typed by the file it is about to write, which is also why it imports `db.ts` and not `client.ts`.

**`client.ts`** -- the instance your application code imports, created once and typed by `db.generated.ts`:

```ts
export const pgRest = await createQuery<DatabasePgRest>(options);
```

**`main.ts`** -- the queries. That one type argument is what makes everything inside follow:

```ts
const pgRest = await createQuery<DatabasePgRest>(options);

const { data: todos, error } = await pgRest.select({
  table: "todos", //                                  only a relation of the exposed schema
  columns: ["id", "title", "priority", { tags: ["label"] }], //  real columns, real relationship
  where: { done: false }, //                          its own columns, with the right value type
  order: [{ column: "priority", desc: true }],
  limit: 10,
});
if (error) throw error; //                            a failure is part of the result, never a rejection
```

`todos` is inferred, nesting included:

```ts
Array<{ id: number; title: string; priority: "low" | "normal" | "high"; tags: Array<{ label: string }> }>
```

## What the generated file looks like

83 lines for this schema, with no imports. The enum became a union, the composite type a named object type, `id` is
absent from `insert` because `GENERATED ALWAYS AS IDENTITY` refuses a value, `title` is required and the columns with a
default are optional:

```ts
/** The `api.place` composite type. */
type DatabasePgRestCompositeApiPlace = { room: string | null; floor: number | null };

type DatabasePgRestApiRelations = {
  todos: {
    row: { id: number; title: string; /* … */ at: DatabasePgRestCompositeApiPlace | null };
    insert: { title: string; done?: boolean; /* … */ at?: DatabasePgRestCompositeInput<DatabasePgRestCompositeApiPlace> | null };
    update: { title?: string; done?: boolean; priority?: "low" | "normal" | "high"; due?: string | null };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: { tags: { rel: "tags"; to: "many" } };
  };
  // tags…
};

type DatabasePgRestApiFunctions = {
  open_todos: [{ args: {}; returns: DatabasePgRestApiRelations["todos"]["row"]; set: true }];
};

export type DatabasePgRest = {
  default: "api";
  schemas: { api: { relations: DatabasePgRestApiRelations; functions: DatabasePgRestApiFunctions } };
};
```

## In your editor

The table restricts the columns, and not only when the compiler runs: inside `columns` on `tags`, the completion offers
`id`, `todo_id`, `label` and `*` -- the three columns of that table, and nothing from `todos`. Same inside `where`, and
the relationships you may embed are the ones a foreign key actually leads to.

## What it refuses

`mistakes.ts` is a list of mistakes, each with `@ts-expect-error` above it -- which is the assertion that it *is* one:
`npm run typecheck` fails if any of them ever starts compiling. Remove a comment to read the message:

```ts
// @ts-expect-error "urgent" is not one of the enum's labels
void pgRest.select({ table: "todos", where: { priority: "urgent" } });

// @ts-expect-error `id` is generated: it cannot be written
void pgRest.insert({ table: "todos", rows: { id: 42, title: "nope" } });

// @ts-expect-error `floor` is an int -- the fields of a composite type are checked like any other value
void pgRest.select({ table: "todos", where: { at: { floor: "2" } } });

// @ts-expect-error a misspelled field would be dropped in silence at runtime
void pgRest.select({ table: "todos", columns: ["id"], limitt: 10 });
```

Not everything can be described: casts (`total::text`), JSON paths (`meta->>tier`) and aggregates (`total.sum()`) change
or invent a column, so they are errors here and belong on an instance created without a type argument -- which keeps
working exactly as before.

## Where to look next

This example is deliberately bare. The others add what a real application needs: a server
([`with-pglite`](../../rest/with-pglite), [`with-node-postgres`](../../rest/with-node-postgres)), Row Level Security, and a real sign-in
([`with-better-auth`](../../rest/with-better-auth)). The reference for everything above is
[`docs/query.md`](../../../docs/query.md) and [`docs/types.md`](../../../docs/types.md).
