# Security

Two things carry the weight: Postgres decides what a caller may do, and request values never become SQL.

## The caller is a role and some claims

```ts
await pgRest.select({ table: "notes", columns: ["body"] }, { role: "authenticated", claims: { sub: user.id } });
```

Inside the request's transaction, pg-rest issues one statement that sets them with `set_config(…, true)`
(transaction-local):

| GUC | from |
| --- | --- |
| `role` | `ctx.role`, or `anonymousRole` when there is none |
| `request.jwt.claims` | `ctx.claims`, with `role` merged in — what RLS policies read |
| `search_path` | the selected schema, then `extraSearchPath` |
| `request.method`, `request.path`, `request.headers`, `request.cookies` | the request (`requestSettings`, on by default). Set by `@tspg/rest` only: an in-process operation has no request and sets none of them |
| anything in `ctx.settings` | your own, names must contain a dot (`app.tenant_id`) |

So a policy is written exactly as it would be behind PostgREST:

```sql
ALTER TABLE api.notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON api.notes
  USING (owner = (current_setting('request.jwt.claims', true)::json ->> 'sub'));
```

Three consequences worth stating plainly:

- **The database is the enforcement point.** `SET LOCAL role` means `GRANT` and RLS apply to every statement, including
  the ones an in-process operation runs. A privilege error comes back as `42501` → 401 (anonymous) or 403.
- **No type knows what a role may do.** The generated types describe the schema, not the caller: an insert as `anon`
  compiles and Postgres refuses it. One schema serves every role, the role is usually resolved from a cookie, and RLS is
  a predicate over rows. → [`types.md`](types.md#what-it-will-not-describe-the-caller)
- **`anonymousRole: false`** refuses a call with no context outright (`401 PGRST302`), which is the switch to flip if
  nothing in your application should ever be readable anonymously.

## Request values never become SQL

Values arrive as parameters — always text; the JSON body of a write and the arguments of a function with an explicit `$n::text` cast, and the operations' filter values as bound parameters of the type they are compared with — or, over HTTP, as escaped literals. Identifiers are
quoted through one module, cast targets must match a strict type allowlist, and a GUC name must be dotted.
The `security.test.ts` suite of each package throws SQL injection payloads at filters, identifiers, casts, write payloads, `on_conflict`,
`columns`, RPC arguments, headers and cookies, and asserts the data is still there afterwards — through `handle()` and
through the operations, where the object builder quotes values itself.

A read runs in a `READ ONLY` transaction, so a `GET` cannot write even through a volatile function.

## What is yours to do

- **CORS, CSRF, rate limiting, request size.** They depend on your deployment, so they live in your server or
  middleware. If browsers call pg-rest with cookies, apply your usual CSRF defences (SameSite cookies, an `Origin`
  check) in middleware or in `resolveContext`.
- **`planEnabled`.** A query plan reveals the shape of the database; leave it off in production, or restrict it.
- **Exposed schemas.** `schemas` is an allowlist: `pg_catalog` and `information_schema` are refused outright, and
  anything you do not name is unreachable. Keep auth tables in a schema you do not expose — that is what
  [`examples/rest/with-better-auth`](../examples/rest/with-better-auth) does with Better Auth's tables.
- **The connecting role.** pg-rest only ever `SET LOCAL role`s to what you give it, so the driver's own role should be
  one that can assume those roles and nothing more.
