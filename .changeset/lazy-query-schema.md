---
"@tspg/core": minor
"@tspg/query": minor
---

feat(query): create an instance from `schemas` alone, and generate from the same options

`createQuery`'s `schema` descriptor is now optional. Given `schemas` instead, the instance reads the catalog itself —
once, on its first operation, or on the new `ready()` — so a typed client is `createQuery<Db>({ db, schemas: ["api"] })`
with no codegen step. A descriptor still means the catalog is never read, and the queries are typed the same either way.
`ready()` is also what `prepare()` needs on an instance with no descriptor, since planning is synchronous.

`@tspg/query/types` follows: `introspect`, `generateTypes`, `generateSchema` and `generateModule` each take
`createQuery`'s own options as their single source, read the catalog themselves and return a promise, so a generator
script is one call — `await generateTypes(options, { name: "Database" })`. They still accept a `SchemaCache` for a script
writing several modules from one read.
