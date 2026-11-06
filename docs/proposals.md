# Proposals

Four additions under consideration, none of them built. They are here to be argued with before they are written: the
API sketches are illustrative, and the code blocks on this page are fenced so the documentation test does not compile
them against a library that does not have them yet.

They share a premise. Parity with PostgREST v16 is nearly complete and the differential suite keeps it honest
([`PARITY.md`](../PARITY.md)), so what is left to add is not more parity — it is what only a **library** can do, and
what a library owes an application it runs inside of. [`design.md`](design.md) draws that line: ➖ is refused on
purpose, ❌ is not done yet. Everything below is a third thing: considered, and not decided.

- [1. A transaction across several queries](#1-a-transaction-across-several-queries)
- [2. Observability hooks](#2-observability-hooks)
- [3. Guardrails for an exposed surface](#3-guardrails-for-an-exposed-surface)
- [4. A debug mode](#4-a-debug-mode)

## 1. A transaction across several queries

**Today.** Every call opens its own transaction (`execute`, `src/core.ts`), which is right for a request — one request,
one transaction, the role and claims set with `set_config` inside it — and is the whole story for `handle()`. But
`query()` is called from application code, where two writes that must land together are ordinary, and there is no way
to say so. The answer today is to leave the library: run the SQL yourself, and lose the parser, the embedding and the
error mapping for those two statements.

**The shape.** One scope, one transaction, the context applied once for all of it, rollback when the callback throws.
Both entry points carry it, because both are places application code runs a query:

```ts ignore
// the context given at the scope
const { data, error } = await pgRest.transaction(async (tx) => {
  const { data: order } = await tx.query({ table: "orders", insert: { client_id: 1 }, single: true });
  await tx.query({ table: "order_lines", insert: linesFor(order.id) });
  return order;
}, { role: "authenticated", claims: { sub: user.id, email: user.email } });

// the context already decided, read from wherever your middleware put it
const pgQuery = pgRest.setContextQuery(() => store.getStore());

const { data, error } = await pgQuery.transaction(async (tx) => {
  await tx.query({ table: "orders", insert: { client_id: 1 } });
});
```

It asks nothing new of [`adapters.md`](adapters.md): `DbAdapter.transaction(fn)` already hands out a session for the
extent of a callback, which is exactly the shape of the scope. The context is applied where it always was — once, in
the transaction `set_config` runs in.

`transaction` answers a `QueryResult` like `query` does, around whatever the callback returned: `data` is that value,
there is no `count`, and it never rejects. A throw inside the scope rolls the transaction back and comes back as
`error` — a `QueryError` if it was one, a 500 carrying the original under `cause` if it was anything else.

**`tx.query` takes no context, and cannot.** That is the one thing about the signature worth stating. The role and the
claims are set with `set_config(…, true)`, which is transaction-local and issued once at the head of the transaction;
honouring a per-call context would mean issuing `set_config` again halfway through, which scopes nothing — it changes
the role for every statement that follows in the same transaction, in row order, with no way back. So `tx.query` is
`query` minus its second parameter, and a context passed to it is a type error rather than an argument that is quietly
ignored.

What that moves, rather than removes, is `setContextQuery`'s escape hatch — a context passed to the call wins over the
ambient one, which is how an administrative query steps out of it. Inside a scope it cannot exist; at the scope it can,
and that is the granularity `set_config` already works at: `pgQuery.transaction(fn, ctx)` overrides the ambient context
for the whole transaction, exactly as `pgQuery(input, ctx)` does for one query. Another role means another transaction.

**Where the bound form reads its context.** `query` reads the `source` at *every* call, which is what lets one bound
`pgQuery` serve a different context for every request in flight. A scope must read it **once, on entry**: the
transaction has one `set_config`, so a source that answered differently halfway through could not be honoured anyway.
A source that answers nothing is the `PGRSTX01` / `no_context` failure it already is, returned before the `BEGIN`
rather than leaving an empty transaction open.

**What it costs in types.** `ContextQuery` stops being a function type and becomes a callable interface with a
`transaction` member — additive for everyone, since it is only ever a return type (`ContextSource`, the input, is
untouched). Same for `TypedContextQuery<Db>`, and `TypedPgRestInstance` grows `transaction` in the `Omit` it already
applies to `query` and `setContextQuery`, so the scope is typed by the database like everything else.

It leaves one asymmetry: the bound query is callable (`pgQuery(input)`) while the scope is an object
(`tx.query(input)`). Keeping both is deliberate — the callable form is what is documented and in use, and an object is
what lets a scope name a second thing later without changing a signature again — but it is the kind of inconsistency
worth disliking out loud before it ships.

**What the scope has to decide.** Three behaviours are per-transaction today and currently decided by the single query
that owns the transaction:

- **An error poisons the rest of the scope.** `query()` returns failures rather than throwing, but PostgreSQL has still
  aborted the transaction: the next `tx.query` answers `25P02`. One transaction per call makes that isolation free; a
  shared scope has to choose between a `SAVEPOINT` around each query — plain statements, so nothing in the adapter
  contract is in the way — and letting the first error condemn the scope.
- **`SET TRANSACTION READ ONLY`** (`src/core.ts`) comes from the plan, so in a scope it would come from whichever query
  went first. It has to be dropped inside one, or decided for the whole scope.
- **The serialization retry** (up to 2 on `40001`) replays the transaction. pg-rest still owns the boundary here, so it
  *could* — but replaying the transaction means replaying the callback, and what else that callback does is not the
  library's to repeat. Off inside a scope, or opt-in with that said out loud.

**The harder, separate half: joining a transaction the application opened.**

```ts ignore
await pool.transaction(async (session) => {
  await myOwnMigrationStep(session);
  await pgRest.query({ table: "todos", insert: { title: "t" } }, { role: "authenticated", session });
});
```

That is what would make the layer composable with the rest of the codebase — Drizzle, a job runner, a `pg` transaction
in a webhook — and it is the one thing a PostgREST process can never offer, because it is not in the process. The cost
is not the adapter interface either (a `session()` exported per adapter, plus a `ctx.session` the core honours, is
additive). It is that the transaction semantics of `execute` are *defined* by owning the boundary: `RollbackWith`
throws in order to force a `ROLLBACK`, which is how `Prefer: tx=rollback` and plan output work, and the `PGRST116` and
`PGRST124` checks throw in order to undo the write they just measured. Neither is ours to do to a transaction we did
not open — you cannot roll back the caller's work. That one stays a question; the scope above does not depend on it.

## 2. Observability hooks

**Today.** Nothing. `grep -rn "onQuery\|hook\|logger" src/` finds one comment. PostgREST's `log-level` and
`server-timing` are marked ➖ in [`PARITY.md`](../PARITY.md) as a host concern, and that is the right call — but the
host cannot instrument what it cannot see. Right now a slow query inside `handle()` is invisible from the outside: the
application holds the pool, and sees a `Response`.

**The shape.** One optional callback, called once per executed statement, and nothing else:

```ts ignore
const pgRest = await createPgRest({
  db: nodePostgresAdapter(pool),
  onQuery: (event) => {
    //        sql, params, durationMs, rowCount, status, error, role, source: "handle" | "query"
    if (event.durationMs > 200) console.warn(event.sql);
  },
});
```

That is enough for a slow-query log, an OpenTelemetry span, a Sentry breadcrumb or a counter, and it keeps the library
at zero runtime dependencies: pg-rest emits the event, the application decides what an event *is*. No OTel import, no
logger interface to satisfy, no log levels to configure.

**What it must not become.** A second error channel. The hook is for measurement; failures already have one
(`ApiError`, `QueryError`), and a hook that throws must not be able to fail a request that worked — so it is wrapped,
and an exception from it is swallowed after being reported once.

**Open questions.** Whether one event per statement or one per request is the useful granularity (a read with embeds is
one statement; a write with `return=representation` is not always), and whether `params` belongs in it at all —
it carries user data, which is exactly what a log must not leak by default.

## 3. Guardrails for an exposed surface

**Today.** `handle()` is meant to be mounted on the public internet, and nothing bounds what one request can cost.
There is `maxRows`, which bounds the *answer*. There is no statement timeout, no cap on embedding depth, no cap on the
number of filters, no limit on the size of a body. PostgREST leans on the database for this — `ALTER ROLE authenticator
SET statement_timeout` — which works, and which a library can offer in the one place the application is already
configuring everything else.

**The shape.** Options, with the enforcement where it is cheapest:

| option | where | cost |
| --- | --- | --- |
| `statementTimeout: "3s"` | `SET LOCAL statement_timeout` in the transaction that already exists | a few lines; the database does the work |
| `maxEmbedDepth: 4` | the `select` parser, which already tracks depth | a check, no new traversal |
| `maxFilters: 50` | after parsing the filter tree | a count |
| `maxBodyBytes: 1_000_000` | `handle()`, before reading the body | a header check and a stream guard |

The first one is the one that matters: a nested embed over a large table is an expensive query to write by accident and
a free one to send on purpose. A timeout turns it into a `57014` the existing SQLSTATE table already maps to a status.

**Why it belongs here rather than in the host.** A reverse proxy can bound the body and the clock, but not the shape of
the query — the depth and the filter count are only knowable after the parse, which is inside the library. And a
default-safe `statementTimeout` is the difference between "compatible with PostgREST" and "deployable without reading
the source first".

**Open questions.** Whether any of them should be on by default (a default that breaks a working deployment on upgrade
is worse than no default), and what the error body is: a `PGRSTxxx` code of our own departs from parity, and reusing
`PGRST103` or the `57014` mapping does not say what actually happened.

## 4. A debug mode

**Today.** When a query answers something unexpected — a filter that matches nothing, an embed that came back `null`,
a `where` on a composite that did not do what it looked like — there is no way to see what was actually sent to
PostgreSQL. `QueryError` carries the `input` that produced it and a readable `summary`, which is most of the way there
for a *failure*; a query that succeeds and is merely wrong offers nothing. `Accept: application/vnd.pgrst.plan` exists
behind `planEnabled` and gives the plan, which is the shape of the execution rather than the statement, and only over
HTTP.

**The shape.** An opt-in that makes the pipeline's intermediate values visible where the result already is:

```ts ignore
const pgRest = await createPgRest({ db: nodePostgresAdapter(pool), debug: true });

const { data, error, debug } = await pgRest.query({ table: "todos", select: ["id", { tags: ["label"] }] });
debug?.sql; //      the statement, as the builders wrote it
debug?.params; //   the values, in order -- nothing is interpolated, which is the point
debug?.parsed; //   the ParsedQuery: the select tree, the filter tree, order, paging
debug?.timings; //  parse, plan, execute
```

Over HTTP the same thing is a response header or a sidecar body, under the same flag. And `QueryError` gains the `sql`
it was missing, so a failure explains itself without a second run.

**Why it is separate from the hooks.** Different audience, opposite defaults. [2](#2-observability-hooks) is production
telemetry: always on, aggregated, must not carry user data. This is a development instrument: off, verbose, and
deliberately carrying everything — the statement, the values, the parse tree. Conflating them would mean a production
log that leaks the schema and the parameters, which is the reasoning `planEnabled` already follows (a plan reveals the
structure of the database: keep it off in production). `debug` inherits that warning verbatim, and the OpenAPI and plan
precedent for how to say it.

**What it is worth.** The parse tree is the part that cannot be reconstructed from outside. PostgREST's grammars are
lenient on purpose — a `select` parse stops where it cannot continue, `limit=abc` is ignored rather than refused — so
"this URL did not mean what you thought" is a whole class of confusion that one printed tree ends. The library already
holds that tree; the proposal is only to stop throwing it away.

**Open questions.** Whether `debug` is a constructor option, a per-call flag, or both (a per-call flag is the honest
answer for a production instance debugging one endpoint, and a wider surface to keep correct); and whether the SQL is
handed over as text with separate params, or pre-interpolated for pasting into `psql` — which would mean the library
rendering values into SQL, in one path, after going to some length never to do that anywhere else.
