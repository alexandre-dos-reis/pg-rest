---
"@tsql/rest": patch
"@tsql/query": patch
---

The query-string parser does less work on the way to a successful parse: error messages are built only when one is reported, and combinators no longer allocate on every step. `parseQuery` on a typical query takes about a quarter less time; messages and results are unchanged.
