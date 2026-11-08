# Types generated from the database

`generateModule()` writes a TypeScript module describing your schema, and `createQuery<Database>` hands its types to
the operations so the queries check themselves. The module also carries the **schema descriptor** `createQuery` runs on, so
the types and what the library does come from one read of `pg_catalog`, with no second source of truth to drift — and
a running server never reads the catalog at all.

The checking is the compiler's and nothing else: the descriptor is trusted as generated, and no query is validated
against it at runtime, which keeps the operations fast.

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
import { generateModule, introspect } from "@tsql/query/types";

const cache = await introspect(nodePostgresAdapter(pool), ["api"]);
writeFileSync("src/db.generated.ts", generateModule(cache, { name: "Database" }));
```

The file exports the type `Database` and the descriptor `schema`, and `createQuery<Database>({ db, schema })` takes both.
No CLI and no second database connection: you already have a driver. This is build-time code, which a server that only
serves queries never loads.

`generateTypes(cache)` gives the types alone and `generateSchema(cache)` the descriptor alone, for when they go in
different files.

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
| `rel` | every name you may embed, with `to: "one" \| "many"` — resolved by `findRelationships`, **the same function the query path uses**, so a `columns` the types accept is one the library can resolve. An ambiguous pair carries `hints`, because the query will need one (an `invalid_embed` error otherwise) |
| `functions` | arguments with their optionality, overloads as a tuple, and the result: a relation's `row`, a scalar, or `null` for `void` |
| enums | the labels, as a union — `"sad" \| "ok" \| "happy"`, and `("sad" \| "ok")[]` for an array of them |
| composite types | a named type per [composite type](https://www.postgresql.org/docs/current/rowtypes.html) the schema reaches, nesting included — see [below](#composite-types) |

Every exposed schema is in there; `default` is the first one.

### Composite types

A column of a composite type gets the type's fields, not `unknown`. Each one is declared once, above the relations, and
referred to by name — including the composites nested inside another, and those of a function's arguments or result:

```ts ignore
/** The `api.address` composite type. */
type DatabaseCompositeApiAddress = {
  city: string | null;
  zip: string | null;
};

/** A composite value being written or compared: any of its fields may be left out. */
type DatabaseCompositeInput<T> = T extends ReadonlyArray<infer E>
  ? ReadonlyArray<DatabaseCompositeInput<E>>
  : T extends object
    ? { readonly [K in keyof T]?: DatabaseCompositeInput<T[K]> }
    : T;

type DatabaseApiRelations = {
  venues: {
    row: { id: number; owner: DatabaseCompositeApiContact | null; branches: DatabaseCompositeApiAddress[] | null };
    insert: { owner?: DatabaseCompositeInput<DatabaseCompositeApiContact> | null };
    // ...
  };
};
```

Every field is nullable in `row`, because a composite attribute cannot be `NOT NULL`. On the way **in** — an insert, an
update, a function argument — the fields are optional instead: a value written or compared with fields left out has
NULL there, which is what Postgres does with a short row literal. Comparing works the same way, so a `where` takes a
partial value too. What that means for a query is in [`query.md`](query.md#composite-types).

Only the composite types the module actually mentions are declared, so a `noUnusedLocals` build stays clean.

## A typed instance

```ts
const pgRest = createQuery<Database>({ db: nodePostgresAdapter(pool), schema });
```

From there, `table` and `rpc` are the ones that exist, `columns`, `where` and `order` only name real columns and
relationships, the payload of a write is the relation's insert or update shape, and `data` is inferred from the
`columns` (or, on a write, `returning`) — see [`query.md`](query.md) for the whole surface. The inference follows what the runtime actually answers:

| in the query | in `data` |
| --- | --- |
| a to-one embed | the row, or `null` — and not null under `inner: true` |
| a to-many embed | an array |
| `as: "who"` | the key is renamed |
| `spread: true` | the columns join the parent row; spreading a to-many turns each into an array |
| `single: true` | the object alone |
| `returning: "minimal"` | `null` |
| a function | its signature's result, an array when it returns a set |

`count` follows the same rule, on the result rather than on `data`: `"exact"` and `"estimated"` give a `number`,
`"planned"` a `number | undefined` because an `EXPLAIN` can give nothing usable, and no `count` at all gives
`undefined` — see [`query.md`](query.md#what-comes-back).

The type argument goes on `createQuery`, not on the call. TypeScript stops inferring the remaining type arguments as
soon as one is given explicitly, so `query<Database>({ … })` would check the input and then hand back `unknown` —
measured both ways before settling on this shape.

An instance created **without** a type argument keeps the loose input and `query<Todo[]>(…)` to name the result
yourself, which is the escape hatch for everything below. `handle()` of `@tsql/rest` has no such type: an HTTP request is a
string from outside and cannot be typed.

## In your editor

The table restricts the columns in the completion list too, not only when the compiler runs: inside `columns` on `tags`,
you are offered that table's columns and nothing from `todos`. Each property carries its documentation, and hovering
`select` explains the whole shape.

That is not free, and it is easy to undo by accident: TypeScript narrows the contextual type of a nested property only
when the discriminant picks **exactly one** member of the union, so each operation's type (`TypedSelect`, `TypedInsert`, `TypedUpdate`…) keeps one member per table, and
`TypedRpc` one per function; an operation's payload (`rows`, `set`) is required by its own type, and absent from the others. `tests/completions.test.ts` asks the compiler and pins the answer.

Hovering a property you have already written shows its *inferred* type and no documentation: the parameter is the
inferred query, so there is no declared property for the editor to point at. That is the price of inferring `data` from
the `columns` (or, on a write, the `returning` list).

## What it cannot describe

Deliberately `unknown` rather than a plausible `string`: `json`/`jsonb`, domains, PostGIS, and anything unrecognised. A
type that is merely plausible is the one that bites. (Composite types *are* described — see
[above](#composite-types) — because the catalog carries their fields.)

Three more gaps, each for a reason:

- **View nullability.** The catalog reports *every* view column as nullable (`attnotnull` is false on a view), so the
  default is `| null`. Refining it from the source column would be unsound in general — a `NOT NULL` column behind a
  `LEFT JOIN` can still come back null — so the source is exposed as `Column.source` and `views: "like-source"` is
  opt-in, for someone who knows their views.
- **`RETURNS TABLE(…)` functions** give `Record<string, unknown>`: the catalog does not carry their output columns, and
  neither does the request path (it builds a relation with no columns). The types are as precise as the runtime, not
  more.
- **Casts, JSON paths and aggregates** in `columns` — `total::text`, `meta->>tier`, `total.sum()` — change or invent a
  column, and reading that back out of a string literal would cost more than it gives. They are compile errors on a
  typed instance and work as always on an untyped one. A JSON path in a `where` (`"meta->>tier"`) is accepted on a real
  column, since a filter does not change the result; its value is only checked for shape.

## What it will not describe: the caller

`insertable` and its siblings come from `pg_relation_is_updatable`, which is structural — an aggregate view can never be
written, whoever asks — and say nothing about `GRANT`. An insert as `anon` therefore compiles, and Postgres answers
`42501` → 401.

That is the design, not an oversight: one schema serves every role, the role is usually resolved from a cookie at
runtime so the compiler never sees it, and row level security is a predicate over rows that no type can express. See
[`security.md`](security.md).
