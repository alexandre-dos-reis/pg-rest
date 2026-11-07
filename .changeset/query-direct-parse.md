---
"@tsql/query": patch
---

`query()` no longer renders its object as a query string for the engine to parse again: the common shapes (plain columns, `$` operators, `$or`/`$and`/`$not`, order, paging, embedded resources) are built straight into the parsed form. The CPU `query()` spends before the statement goes to the driver drops from about 215 µs to about 18 µs on a typical query. A shape the shortcut does not cover (a JSON path, a cast, an aggregate, a dotted key) takes the old route, so results and errors are unchanged.
