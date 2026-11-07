---
"@adrdp/pg-rest": minor
---

**Breaking:** `where` filters are written with `$`-prefixed operators, the way MongoDB and Prisma-style libraries do.

- `total: ["gte", 100]` and `total: { op: "gte", value: 100 }` become `total: { $gte: 100 }`. The two former forms are refused with an error that says what to write instead, rather than read as an equality.
- Several operators on one column are ANDed: `{ $gte: 100, $lt: 500 }`.
- `not` and `quantifier` become wrappers: `{ $not: { $in: [1, 2] } }`, `{ $any: { $like: ["a*", "b*"] } }`. Full-text takes its configuration in the value: `{ $fts: { query: "ada", config: "english" } }`.
- `and` / `or` become `$and` / `$or`, and `$not: { … }` inverts a group. A column may now be called `and` or `or`.
- To compare a column with an array, write `{ $eq: [...] }`: an array is no longer a condition on its own.
- In typed queries, the operators a column accepts follow its type (`$like` on text, `$cs` on arrays, `$gt` on ordered types).
- `FilterSpec` is replaced by `OperatorSpec`.
