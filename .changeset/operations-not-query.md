---
"@tsql/query": minor
---

**Breaking:** `query()` is gone; each operation is a method of its own — `select`, `insert`, `upsert`, `update`, `delete` and `rpc` — and `action` is no longer a key.

- `pgRest.query({ table: "todos", action: "insert", rows })` becomes `pgRest.insert({ table: "todos", rows })`; a read is `pgRest.select({ table })`, a function call `pgRest.rpc({ name: "add" })`. The input is the old one minus `action`, so nothing else changes — filters, `select`, `returning`, `single`, `count`, the optional `ctx`.
- The same six methods are on a transaction scope (`tx.insert(...)`, which rejects on failure as `tx.query` did) and on what `setContextQuery()` returns, which is no longer callable: `db({ table })` becomes `db.select({ table })`.
- The method decides the `action`, even if the object you pass has one: `select(input)` can never delete.
- Typed instances check each operation against its own type: `rows` is required by `insert`/`upsert`, `set` by `update`, and the other methods refuse them. `TypedQuery` is replaced by `TypedSelect`, `TypedInsert`, `TypedUpsert`, `TypedUpdate`, `TypedDelete` and `TypedRpc`.
- `prepare()` takes a function that returns a `select` (`SelectInput`).
- A `QueryError`'s `input` now carries the `action` of the method that was called.
- **`select` is `columns`.** `pgRest.select({ table, select: ["id"] })` becomes `pgRest.select({ table, columns: ["id"] })`, and the same in an embed's long form (`{ orders: { columns: [...], inner: true } }`) and in `rpc`.
- On a write, the columns to return are `returning`, which now takes a list as well as `"representation"` and `"minimal"`: `pgRest.insert({ table, rows, returning: ["id"] })`. An insert's own `columns` (the columns it inserts) is unchanged, and `data` is typed from `returning` only.
