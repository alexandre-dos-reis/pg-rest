---
"@adrdp/pg-rest": minor
---

Add `generateTypes(cache)`, published as `@adrdp/pg-rest/types`: TypeScript types for your database, generated from
`schemaCache()` — the introspected catalog the request path itself reads, so what the types allow is what the library
accepts.

```ts
import { writeFileSync } from "node:fs";
import { generateTypes } from "@adrdp/pg-rest/types";

writeFileSync("src/db.types.ts", generateTypes(await pgRest.schemaCache(), { name: "DatabasePgRest" }));
```

It emits `row` / `insert` / `update` per relation (generated columns left out of writes, optional where there is a
default or a nullable column, `never` where the relation cannot be written), the primary key and the privileges, every
embeddable name with `to: "one" | "many"` — resolved by `findRelationships`, the same function the request path uses —
and the functions with their arguments, optionality, overloads and result type. The output is a plain module with no
imports: commit it, and add it to your formatter's ignore list.

Unrecognised types become `unknown` rather than a plausible `string`. A view column is typed `| null` because that is
what the catalog says of every view column; `views: "like-source"` follows the source column instead.

Two additions to the introspection, which the generator needed and which are useful on their own:

- `Column.enumLabels` / `FunctionArg.enumLabels` / `FunctionDef.returnEnumLabels`: the labels of an enum type, in
  declaration order, for a column, argument or result that is an enum or an array of one. Enums become a union of string
  literals in the generated types.
- `Column.source`: for a view column read straight from a table column, that column, followed through view-over-view
  chains. `nullable` is unchanged (the catalog reports every view column as nullable, and a `NOT NULL` source says
  nothing about a `LEFT JOIN` in the view's own query).
