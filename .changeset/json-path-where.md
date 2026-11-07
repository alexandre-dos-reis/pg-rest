---
"@adrdp/pg-rest": minor
---

Typed queries accept a JSON path in a `where` (`{ "meta->>tier": { $ilike: "go*" } }`). A filter does not change the shape of the result, so the reason a `select` refuses a path does not apply; the column before `->` is still checked, and the value only for its shape.
