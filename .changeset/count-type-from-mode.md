---
"@adrdp/pg-rest": minor
---

**Breaking:** `query()` hands failures back in the result, and `querySafe()` is gone.

What `querySafe` did is what `query` does now, under the shorter name: `{ data, count, status, error }`, exactly one of
`data` and `error` set, and it **never rejects** — not even on a failure the library did not foresee, which arrives as a
500 `error` carrying the original under `cause`. One form instead of two, and no `try`/`catch` anywhere.

```ts
const { data, error } = await pgRest.query({ table: "todos", select: ["id"] });
if (error) return c.json(error.body, error.status);
// data is narrowed from here on
```

To migrate: rename `querySafe` to `query`, and replace a `try`/`catch` around `query` with `if (error)`. `error` is the
same `QueryError` the throwing form raised, so what you do with it does not change. The types follow: `QuerySafeResult`
is gone, `QueryResult` is now the union, and its two halves are exported as `QueryOk` and `QueryFailed`.

Also: `count` is typed from the `count` the query asked for, instead of always being `number | undefined`.

```ts
const { data, count, error } = await pgRest.query({ table: "todos", select: ["id"], count: "exact" });
if (error) throw error;
// count: number -- asked for, so there is nothing to test for
```

`"exact"` and `"estimated"` always answer with a number: when paging leaves nothing to look past, that number is the
page's own length. `"planned"` stays `number | undefined`, because it reads `Plan Rows` out of an `EXPLAIN` which can
come back with nothing usable. No `count` in the query is `undefined`, on both halves of the result. An instance created
without a type argument keeps `number | undefined`, as before.
