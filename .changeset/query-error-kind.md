---
"@adrdp/pg-rest": minor
---

`query()` errors say what went wrong in a way both a program and a person can read.

The `error` of a result carried the PostgREST body and nothing else to branch on: `code` is exact — a `PGRSTxxx` code or
a SQLSTATE — but there are dozens of them, so telling "the row already exists" from "you are not signed in" meant
keeping a table of codes on the calling side. Two additions, and nothing removed:

- **`error.kind`**, a closed string union (`QueryErrorKind`) every code maps onto: `invalid_query`, `invalid_payload`,
  `undefined_object`, `invalid_embed`, `not_single_row`, `too_many_affected`, `unauthenticated`, `forbidden`,
  `conflict`, `invalid_data`, `raised`, `unsupported`, `unavailable`, `no_context`, `internal`. The members are the
  cases that call for *different reactions*, so a `switch` on it is exhaustive-checked by the compiler. `code` is still
  there for the exact reason. The mapping is exported for an `ApiError` held from `handle()` too: `errorKind(status,
  code)`, with `describeErrorKind(kind)` for its wording.
- **`error.summary`**, the same failure written out for whoever reads it — the call it came from, then what the parser
  or the database said, then `details`, `hint` and the kind, each on its own line:

  ```
  insert on "clients" failed: duplicate key value violates unique constraint "clients_email_key"
    details: Key (email)=(ada@example.com) already exists.
    kind: conflict -- a unique or foreign key constraint rejected the row (23505, HTTP 409)
  ```

`error.message` keeps the one-line `"23505: duplicate key … hint: …"` form, and `error.body` stays exactly the JSON
PostgREST answers with: both are what they were, so nothing that reads them has to change.
