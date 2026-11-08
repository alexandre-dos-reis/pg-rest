---
"@tsql/rest": patch
"@tsql/query": patch
---

The engine no longer knows `preRequest` or the `request.*` settings: each package builds what it adds to a call (`@tsql/rest` from the HTTP request, `@tsql/query` from its own options). `preRequest` behaves as before; `PreRequestInfo.request` of `@tsql/query` is gone, since a query has no request.
