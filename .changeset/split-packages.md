---
"@tsql/rest": minor
"@tsql/query": minor
---

**Breaking:** `@adrdp/pg-rest` is split in two, along the line that was already in the code.

- **`@tsql/rest`** is the PostgREST-compatible handler: `createRest(options)` gives `handle(Request) => Response`, with PostgREST's status codes, headers and error bodies. Nothing in it is an extension of PostgREST.
- **`@tsql/query`** is the in-process API: `createQuery(options)` gives `query()`, `transaction()`, `setContextQuery()` and `generateTypes()`, with the `$` filters and the computed `set` that PostgREST does not have. It has no HTTP in it. The types generator is also `@tsql/query/types`.

They share one core (parsing, SQL, the schema cache, errors, adapters), which each package bundles: there is no third package to install. The adapters are in both, as `@tsql/rest/adapters/*` and `@tsql/query/adapters/*`.

Each package keeps its own schema cache, so an app that uses both creates both and reloads both after a migration:

```ts
const rest = await createRest({ db, schemas: ["api"] });
const db = await createQuery<Database>({ db, schemas: ["api"] });
```

`createPgRest` is gone. The options both share (`db`, `schemas`, `anonymousRole`, `maxRows`, `extraSearchPath`, `requestSettings`, `preRequest`) are the same in both; `resolveContext`, `basePath`, `allowTxOverride`, `planEnabled`, `openApi` and `serverUrl` are `createRest`'s.
