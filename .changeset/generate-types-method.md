---
"@adrdp/pg-rest": minor
---

`pgRest.generateTypes(options?)` writes the TypeScript types without a second import or a trip through the schema cache:

```ts
writeFileSync("src/db.types.ts", await pgRest.generateTypes({ name: "Database" }));
```

The generator is a build-time job, so it is loaded by that call and not before: `dist/index.js` does not carry it, and a
server that only serves requests pays nothing for it (2.9 KB gzipped, measured). `generateTypes(cache, options?)` is
still exported from `@adrdp/pg-rest/types` for when you hold a `SchemaCache` rather than an instance — both routes are
the same function and produce identical output, which a test asserts.
