---
"@tsql/query": minor
---

**Breaking:** `rpc` names its function in `name`, not `rpc`: `pgRest.rpc({ rpc: "add", args })` becomes `pgRest.rpc({ name: "add", args })`. The method keeps its name; only the key changed, so `args`, `columns`, `where` and `order` are untouched.
