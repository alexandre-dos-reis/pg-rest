---
"@adrdp/pg-rest": minor
---

`createPgRest<Db>(options)` types the queries from a generated database type: `table` and `rpc` are the ones that exist,
`select`, `where` and `order` only name real columns and relationships, and `data` is inferred from the `select`.

```ts
const pgRest = await createPgRest<DatabasePgRest>({ db: nodePostgresAdapter(pool), schemas: ["api"] });

const { data } = await pgRest.query({
  table: "todos",
  select: ["id", "title", { tags: ["label"] }],
  where: { done: false },
  limit: 10,
});
// data: Array<{ id: number; title: string; tags: Array<{ label: string }> }>
```

The inference follows what the runtime actually answers: a to-one embed is an object or `null` (not null with
`inner: true`), a to-many embed is an array, `as` renames the key, `spread` merges the columns into the parent row and
turns each one into an array when it spreads a to-many, `single: true` returns the object alone, `returning: "minimal"`
returns `null`, and a function's arguments and result come from its signature, overloads and set-returning included.
Enums are unions of their labels, so a filter only takes a real label. A field that no query accepts — a misspelled
`limitt` the runtime would drop in silence — is refused.

The table restricts the columns in the editor as well as in the compiler: inside `select` on `tags`, the completion
offers that table's columns and nothing from the others. TypeScript narrows the contextual type of a nested property only
when the discriminant picks exactly one member of the union, so the query type keeps one member per table -- reads and
writes merged, each action's payload required and the others refused by `WriteRules` -- and every member declares
`table`, function calls included (`table?: never`). Naming both `table` and `rpc` is now a type error rather than a
runtime one.

The type argument goes on `createPgRest`, not on the call: TypeScript stops inferring the remaining type arguments as
soon as one is given explicitly, so `query<Db>({ … })` could check the input but would then return `unknown`.

Casts (`total::text`), JSON paths (`meta->>tier`) and aggregates (`total.sum()`) are not described by the typed input:
they change or invent a column, and reading that back out of a string literal would cost more than it gives.
`createPgRest(options)` without a type argument is unchanged — the loose input and `query<Todo[]>(…)` still work — and
`handle` is untouched in both cases.
