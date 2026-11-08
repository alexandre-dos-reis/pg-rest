---
"@tsql/rest": patch
"@tsql/query": patch
---

The engine no longer has anything HTTP in it. `execute` returns a neutral `Result` (body, rows, total, the settings it was asked to read); `@tsql/rest` turns it into the status and headers (`Content-Range`, `Location`, `Preference-Applied`, `response.*`), and `planTable` takes an operation instead of an HTTP method. `@tsql/query` reads `total` directly instead of the `Content-Range` header. `PreRequestInfo.method` of `@tsql/query` is now `operation`.
