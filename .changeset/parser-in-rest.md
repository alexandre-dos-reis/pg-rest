---
"@tsql/query": patch
"@tsql/rest": patch
---

The query-string grammar (`parsec`, PostgREST's grammars and `parseQuery`) moves from the core into `@tsql/rest`, the only package that reads a query string. The engine now takes a `ParsedQuery`; `@tsql/query` builds it from its object for every shape -- JSON paths, casts, aggregates, embedded filters and null tests included -- and no longer renders a query string to have it parsed again, so the parser is no longer in its bundle. Two names a query string reserves (`order`, `limit`, `select`, `and`, `or`, `columns`) can now be columns in a `where`; an `$in` without a list, an unknown `$is` value and the like are refused in `query`'s own words.
