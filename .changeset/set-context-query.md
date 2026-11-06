---
"@adrdp/pg-rest": minor
---

`setContextQuery(source)`: `query()` with the context decided once, so it stops being threaded through every layer that
happens to run a query.

`source` is either a fixed `RequestContext` or a function called at **every** call, which is what makes an
`AsyncLocalStorage` work: one `db` at module scope serves a different caller for every request in flight.

```ts
const store = new AsyncLocalStorage<RequestContext>();
const db = pgRest.setContextQuery(() => store.getStore());

app.use(async (c, next) => store.run({ role: "authenticated", claims: { sub: userId } }, next));

const { data, error } = await db({ table: "todos", select: ["id", "title"] });
```

pg-rest holds no store of its own — it stays dependency-free and runtime-neutral, and the context may come from
anywhere. A context passed to the call wins over `source`, for one administrative query without leaving the scope. A
`source` that returns nothing (the store was never entered) is a 500 `PGRSTX01` `error`, not a silent fall back to the
anonymous role. With a generated database type the bound query is typed exactly like `query`, minus `ctx`.
