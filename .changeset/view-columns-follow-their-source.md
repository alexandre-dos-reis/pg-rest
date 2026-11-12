---
"@tspg/query": minor
"@tspg/rest": minor
---

feat: view columns take their nullability and primary key from the table they read

The catalog holds no constraint for a view: `attnotnull` is always false and there is no
`pg_constraint` row, so every view column was typed `| null` and every view had `pk: []`. A view
column read straight from a table column now answers like that column, and a view that exposes
every column of its table's primary key borrows it -- including when the table's schema is not one
of the exposed `schemas`, which is the usual PostgREST arrangement (views in `api` over tables in
`core`).

Columns of a view whose query has a `LEFT`, `RIGHT` or `FULL` join are left alone: an unmatched row
yields null there whatever the source column says.

**Breaking:** the `views: "nullable" | "like-source"` option of `generateTypes` is gone. It existed
because provenance alone could not tell a projection from an outer join; now that it can, the
resolution happens during introspection and the generated types follow. Drop the option -- its
`"like-source"` behaviour is what you get, and soundly.
