---
"@tsql/query": minor
---

`query()` can compute the columns of an `update` in the database, following PostgreSQL's `UPDATE … SET column = { expression | DEFAULT }`.

```ts
set: {
  status: "paid",                                  // a plain value, as before
  total: { $add: [{ $col: "total" }, 10] },        // an expression
  placed_at: { $default: true },                   // DEFAULT
}
```

Operators are `$`-prefixed (`$add`, `$sub`, `$mul`, `$div`, `$mod`, `$pow`, `$concat`, comparisons, `$and`/`$or`/`$not`, `$cast`, `$coalesce`, …) and work on the types they work on in PostgreSQL. A fixed list of functions is there too (`$now`, `$lower`, `$upper`, `$trim`, `$length`, `$abs`, `$round`, `$arrayAppend`, `$arrayRemove`), and on a typed instance an expression has to give the column's type. Nothing is raw SQL: columns are checked against the schema, types against an allowlist, values are escaped.

This is a superset of PostgREST's `PATCH`, available in `query()` only: a plain `set` and the HTTP `PATCH` are unchanged. An object whose keys all start with `$` is read as an expression, so a `jsonb` value like that is written `{ $val: … }`.
