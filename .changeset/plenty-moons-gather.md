---
"@adrdp/pg-rest": minor
---

A transaction across several `query()` calls.

Every call opened its own transaction, which is right for a request and was the whole story for `handle()`. But
`query()` is called from application code, where two writes that must land together are ordinary, and the answer was to
leave the library — run the SQL yourself, and lose the parser, the embedding and the error mapping for those two
statements. `transaction(fn, ctx)` is one scope, one transaction:

```ts
const { data, error } = await pgRest.transaction(async (tx) => {
  const order = await tx.query({ table: "orders", action: "insert", rows: { client_id: 1 }, single: true });
  await tx.query({ table: "order_items", action: "insert", rows: itemsFor(order.data.id) });
  return order.data.id; //                this is the result's `data`
}, { role: "authenticated", claims: { sub: user.id } });
```

It answers a `QueryResult` around whatever the callback returned (`data` is that value, there is no `count`) and never
rejects, like `query()`. Both entry points carry it: `pgRest.transaction(fn, ctx)`, and `pgQuery.transaction(fn)` on a
bound query, which reads its context source **once, on entry**.

`tx.query` differs from `query` in exactly two ways, and both of them follow from sharing a transaction.

- **It takes no context, and cannot.** The role and the claims are `set_config(…, true)`, transaction-local and issued
  once at the head of the transaction; re-issuing them halfway through scopes nothing. A context passed to `tx.query`
  is a type error rather than an argument quietly ignored — the per-call override moves to the scope, which is the
  granularity `set_config` works at: `pgQuery.transaction(fn, { role: "admin" })`.
- **It rejects on failure instead of answering an `error`.** A query that failed is a transaction that will not commit,
  so leaving is the only correct next step and the library takes it rather than asking every call site to. What comes
  back is therefore the success — `data` is not null, `count` is the number the query asked for, and
  `if (error) throw error` disappears. The promise that never rejects moved from the query to the **scope**, where it
  is the only one that can mean anything. What it throws is the same `QueryError` `query()` would have returned.
- **Any failed query stops the scope from committing**, even when a `catch` swallowed it and the callback returned a
  value: `single` and `maxAffected` are checks raised _after_ a statement that worked, and a scope that committed would
  keep the row and report it as refused. The first failure is what the result carries, and a query issued after one is
  refused with `PGRSTX03` rather than PostgreSQL's `25P02`.
- **`tx.transaction(fn)`** is a nested scope on a `SAVEPOINT`, and the one place a transaction may carry on after a
  failure — so unlike `tx.query` it answers a `QueryResult` rather than rejecting: a query that is _allowed_ to fail
  goes in one, and its failure is an `error` you read. **`tx.rollback()`** undoes the scope it is called in and leaves
  it (`PGRSTX02`).
- **`readOnly`**, **`isolationLevel`** and **`retry`** are per-transaction, so the scope decides them rather than
  whichever query went first: `{ readOnly: true }` and `{ isolationLevel: "serializable" }` go in as the transaction's
  first statement, and `{ retry: { attempts, on, delayMs } }` replays the scope on a serialization failure — off by
  default, because replaying the transaction means replaying your callback. `"read uncommitted"` is not among the
  levels: PostgreSQL accepts it and runs `read committed` anyway.

`QueryErrorKind` gains `"rolled_back"` for the two codes above; a `switch` on `kind` with a `default` is unaffected.
`ContextQuery` and `TypedContextQuery<Db>` become callable interfaces carrying `transaction`, which is additive since
both are only ever return types. Driver errors are now normalised per statement rather than on the way out of a
transaction, so a failure caught inside a scope still carries its SQLSTATE.

[`examples/with-transactions`](examples/with-transactions) runs all of it end to end, with the caller read from an
`AsyncLocalStorage`. Joining a transaction the *application* opened is the other half, still in
[`docs/proposals.md`](docs/proposals.md).
