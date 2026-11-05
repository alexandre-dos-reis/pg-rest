---
"@adrdp/pg-rest": minor
---

Add `query(input, ctx?)`: run a query from a plain JavaScript object, in-process, with no `Request`, no URL and no HTTP
status — something a PostgREST server cannot offer, and the reason this is a library.

```ts
const { data } = await pgRest.query({
  table: "todos",
  select: ["id", "title", { tags: ["label"] }],
  where: { done: false, or: [{ priority: ["gte", 3] }, { pinned: true }] },
  order: [{ column: "created", desc: true }],
  limit: 10,
});
```

It is the same pipeline as `handle()`, not a second implementation: the object becomes the query parameters PostgREST would
have parsed, so the `select` trees, every filter operator, embedding, the `set_config` of role and claims (RLS applies),
the SQL builders and the SQLSTATE mapping are all shared. Reads, writes (`insert`, `upsert`, `update`, `delete`) and `rpc`
are covered; content negotiation (CSV, GeoJSON, media type handlers), `EXPLAIN` plans, `Range`, `OPTIONS` and OpenAPI stay
on `handle()`. Failures throw a `QueryError` — an `Error` carrying the PostgREST status and body (`code`, `message`,
`details`, `hint`) plus the input that produced it.

`querySafe(input, ctx?)` is the same query with the failure as a value rather than an exception, for call sites where
that reads better:

```ts
const { data, error } = await pgRest.querySafe({ table: "cients" });
if (error) return c.json(error.body, error.status);
```

Exactly one of `data` and `error` is set, so narrowing on `error` leaves `data` non-null. It is the same `QueryError`
`query()` throws, and `querySafe()` **never rejects** — an unforeseen error comes back as a 500 `error` carrying the
original under `cause`. `query()` itself is unchanged.

Two deliberate defaults differ from HTTP, both reversible: a write returns its rows unless `returning: "minimal"`, and a
function call is always a `POST`.

Also:

- `ApiError.message` now summarises the error for logs and stack traces (`"PGRST205: … hint: …"`). The response body is
  unchanged, so HTTP clients see exactly what they saw before.
- `PreRequestInfo.request` is now optional: an in-process `query()` call has no `Request`. A `preRequest` callback that
  reads it needs a `?.` (or `info.request && …`). SQL `preRequest` functions and everything else are unaffected.
