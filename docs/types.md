# Types generated from the database

`pgRest.generateTypes()` writes a TypeScript module describing your schema, and `createPgRest<Database>` hands it to
`query()` so the queries check themselves. The types come from `schemaCache()` — the introspected `pg_catalog`, the same
one the library reads to answer a request — so what they allow is what it accepts, with no second source of truth to
drift.

- [Generating](#generating)
- [What the file contains](#what-the-file-contains)
- [A typed instance](#a-typed-instance)
- [In your editor](#in-your-editor)
- [What it cannot describe](#what-it-cannot-describe)
- [What it will not describe: the caller](#what-it-will-not-describe-the-caller)

## Generating

```ts
// scripts/gen-types.ts — run it again after a migration
import { writeFileSync } from "node:fs";

writeFileSync("src/db.types.ts", await pgRest.generateTypes({ name: "Database" }));
```

No CLI and no second database connection: you already have a driver, and the library has no runtime dependency to spend
on one. The generator is loaded by that call and not before, so a server that only serves requests never carries it.

When you hold a `SchemaCache` rather than an instance, the same function is exported standalone:

```ts
import { generateTypes } from "@adrdp/pg-rest/types";

const types = generateTypes(await pgRest.schemaCache(), { name: "Database" });
```

| option | |
| --- | --- |
| `name` | the exported type's name. Default `"Database"` |
| `header` | the banner comment; `false` leaves it out |
| `views` | `"nullable"` (default) or `"like-source"` — see [below](#what-it-cannot-describe) |

The output is a plain module with no imports. Commit it, and add it to your formatter's ignore list so the file stays
byte-for-byte what the generator produced.

## What the file contains

```ts ignore
type DatabaseApiRelations = {
  todos: {
    row: { id: number; title: string; done: boolean; priority: "low" | "normal" | "high"; due: string | null };
    insert: { title: string; done?: boolean; priority?: "low" | "normal" | "high"; due?: string | null };
    update: { title?: string; done?: boolean; priority?: "low" | "normal" | "high"; due?: string | null };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: { tags: { rel: "tags"; to: "many" } };
  };
  // one entry per table, view and materialized view of the schema
};

type DatabaseApiFunctions = {
  open_todos: [{ args: {}; returns: DatabaseApiRelations["todos"]["row"]; set: true }];
};

export type Database = {
  default: "api";
  schemas: { api: { relations: DatabaseApiRelations; functions: DatabaseApiFunctions } };
};
```

| | |
| --- | --- |
| `row` | every column, with `\| null` where the catalog says nullable |
| `insert` | what a write accepts: a generated or `GENERATED ALWAYS AS IDENTITY` column is **absent**, one with a default or a nullable one is optional. `never` when the relation cannot be written |
| `update` | the same, all optional |
| `pk`, `insertable`, `updatable`, `deletable` | the primary key, and what `pg_relation_is_updatable` says the relation accepts |
| `rel` | every name you may embed, with `to: "one" \| "many"` — resolved by `findRelationships`, **the same function the request path uses**, so a `select` the types accept is one the library can resolve. An ambiguous pair carries `hints`, because the request will need one (`PGRST201`) |
| `functions` | arguments with their optionality, overloads as a tuple, and the result: a relation's `row`, a scalar, or `null` for `void` |
| enums | the labels, as a union — `"sad" \| "ok" \| "happy"`, and `("sad" \| "ok")[]` for an array of them |

Every exposed schema is in there; `default` is the first one.

## A typed instance

```ts
const pgRest = await createPgRest<Database>({ db: nodePostgresAdapter(pool), schemas: ["api"] });
```

From there, `table` and `rpc` are the ones that exist, `select`, `where` and `order` only name real columns and
relationships, the payload of a write is the relation's insert or update shape, and `data` is inferred from the
`select` — see [`query.md`](query.md) for the whole surface. The inference follows what the runtime actually answers:

| in the query | in `data` |
| --- | --- |
| a to-one embed | the row, or `null` — and not null under `inner: true` |
| a to-many embed | an array |
| `as: "who"` | the key is renamed |
| `spread: true` | the columns join the parent row; spreading a to-many turns each into an array |
| `single: true` | the object alone |
| `returning: "minimal"` | `null` |
| a function | its signature's result, an array when it returns a set |

The type argument goes on `createPgRest`, not on the call. TypeScript stops inferring the remaining type arguments as
soon as one is given explicitly, so `query<Database>({ … })` would check the input and then hand back `unknown` —
measured both ways before settling on this shape.

An instance created **without** a type argument keeps the loose input and `query<Todo[]>(…)` to name the result
yourself, which is the escape hatch for everything below. `handle()` is identical either way: an HTTP request is a
string from outside and cannot be typed.

## In your editor

The table restricts the columns in the completion list too, not only when the compiler runs: inside `select` on `tags`,
you are offered that table's columns and nothing from `todos`. Each property carries its documentation, and hovering
`query` explains the whole shape.

That is not free, and it is easy to undo by accident: TypeScript narrows the contextual type of a nested property only
when the discriminant picks **exactly one** member of the union, so the query type keeps one member per table — reads
and writes merged, each action's payload required by `WriteRules` — and every member declares `table`, function calls
included (`table?: never`). `tests/completions.test.ts` asks the language service and pins the answer.

Hovering a property you have already written shows its *inferred* type and no documentation: the parameter is the
inferred query, so there is no declared property for the editor to point at. That is the price of inferring `data` from
the `select`.

## What it cannot describe

Deliberately `unknown` rather than a plausible `string`: `json`/`jsonb`, domains, composites, PostGIS, and anything
unrecognised. A type that is merely plausible is the one that bites.

Three more gaps, each for a reason:

- **View nullability.** The catalog reports *every* view column as nullable (`attnotnull` is false on a view), so the
  default is `| null`. Refining it from the source column would be unsound in general — a `NOT NULL` column behind a
  `LEFT JOIN` can still come back null — so the source is exposed as `Column.source` and `views: "like-source"` is
  opt-in, for someone who knows their views.
- **`RETURNS TABLE(…)` functions** give `Record<string, unknown>`: the catalog does not carry their output columns, and
  neither does the request path (it builds a relation with no columns). The types are as precise as the runtime, not
  more.
- **Casts, JSON paths and aggregates** in a `select` or a `where` — `total::text`, `meta->>tier`, `total.sum()` — change
  or invent a column, and reading that back out of a string literal would cost more than it gives. They are compile
  errors on a typed instance and work as always on an untyped one.

## What it will not describe: the caller

`insertable` and its siblings come from `pg_relation_is_updatable`, which is structural — an aggregate view can never be
written, whoever asks — and say nothing about `GRANT`. An insert as `anon` therefore compiles, and Postgres answers
`42501` → 401.

That is the design, not an oversight: one schema serves every role, the role is usually resolved from a cookie at
runtime so the compiler never sees it, and row level security is a predicate over rows that no type can express. See
[`security.md`](security.md).
