---
"@tsql/query": patch
"@tsql/rest": patch
---

Close an SQL injection and read hostile names the way PostgREST does.

- `@tsql/query`: the `nulls` of an `order` object was written into the statement as it came, so a value that did not go through the type (a JSON body, say) could add SQL after `NULLS`. It now has to be `"first"` or `"last"`. `table`, `rpc` and `schema` must be strings: an object with its own `toString` is refused instead of being turned into a name.
- `@tsql/rest`: the key of a filter, an embedded filter, a function argument read from the query string, `columns` and `on_conflict` go through PostgREST's grammar. What is not a name answers `PGRST100 failed to parse tree path (…)` (or `columns parameter`, `on_conflict parameter`) and what follows a name is ignored, as PostgREST does, instead of being looked for as a column (`42703`/`PGRST108`/`PGRST202`).
