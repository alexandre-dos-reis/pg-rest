---
"@tsql/query": minor
---

`prepare()` plans a select once and gives back a function of its values: a call is string concatenation and the statement for the driver, with no parsing and no planning. A call is run with `run()` -- on the instance, on a `setContextQuery` function, or as `tx.run()` in a transaction -- and the query is typed and checked against the database like any other.

```ts
const paidOver = pgRest.prepare((a: { status: string; min: number }) => ({
  table: "orders",
  where: { status: a.status, total: { $gte: a.min } },
}));
const { data } = await pgRest.run(paidOver({ status: "paid", min: 100 }), ctx);
```

An argument is a filter value and nothing else (it cannot pick a column, an operator or a limit); `prepare()` throws at set-up time for a query that does not follow that, and for anything but a select. A call with `null`, a `*` wildcard or a composite value runs the ordinary way.
