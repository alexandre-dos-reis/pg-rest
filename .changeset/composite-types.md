---
"@adrdp/pg-rest": minor
---

Composite types are first class: in `query()`, in the SQL, and in the generated types.

A column of a [composite type](https://www.postgresql.org/docs/current/rowtypes.html) could already be read and written
— Postgres hands it over as a nested object, and `json_populate_record` writes one back — but its *fields* were out of
reach, and the generated types called it `unknown`. Three changes:

- **`->`/`->>` into a composite column** (nested, and through an array of them) now work in `select`, `where` and
  `order`, as they do on `jsonb`. pg-rest converts the column with `to_jsonb()` first unless its type is exactly
  `json`/`jsonb` — which is PostgREST's own rule, and was a **parity gap**: `select=owner->>name` answered
  `42883 operator does not exist` where PostgREST answers the field. The same rule applies to arrays and scalars, so
  `select=id->>nope` now answers `null` instead of an error, again like PostgREST.
- **Comparing a whole composite value**, which is pg-rest's own: `where: { owner: { name: "Ada", home: { city: "Paris" } } }`
  sends the value as JSON and turns it into a row of the column's type. The fields may come in any order and the ones
  left out are NULL, exactly like the row literal it stands for. An object is read as a value only when it has no `op`
  key, so the `{ op, value, not }` form is untouched. PostgREST answers `0A000` to any composite comparison (its
  literal has no type to be read as); a bare row literal still does here too.
- **Generated types** describe the fields: one named type per composite type the schema reaches, nesting included, plus
  the types of a function's composite arguments and result. On the way in the fields are optional, since a value
  written or compared may leave them out. `SchemaCache` carries them under `composites`, and a column points at its
  type with `Column.composite`.

Also fixed on the way, found by the new differential cases: a JSON path **ending on an index** is named after the last
key before it (`select=tags->0` is `tags`, `data->1->mycol->>2` is `mycol`), as PostgREST names it — it used to be
`0`/`2`. This affects `json`/`jsonb` columns too.
