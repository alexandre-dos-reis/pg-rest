---
"@tsql/query": minor
---

`query()` passes the values of its filters to the driver as bound parameters (`$1`, `$2`…) instead of writing them into the SQL. The statement text now depends on the shape of the query and not on its values, so the driver and the server reuse the prepared statement and its plan instead of parsing a new text for every value, and a value is never part of the SQL at all. On a typical read that is about a third off the time of a call (`query()` ~450 µs -> ~300 µs, `run(prepared)` ~390 µs -> ~260 µs on the same machine); the statement itself goes from ~170-210 µs to ~60-70 µs.

A value compared with a `json` or `jsonb` column, or with the result of a `->` path, stays a literal, because `Bun.sql` re-encodes a parameter it infers as json. `@tsql/rest` is unchanged: HTTP keeps the literals of its statements. The expressions of an update's `set` are still literals.
