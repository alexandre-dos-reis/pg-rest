# Proposals

Three additions under consideration, plus the half of a fourth that shipped without it. They are here to be argued with
before they are written: the API sketches are illustrative, and the code blocks on this page are fenced so the
documentation test does not compile them against a library that does not have them yet.

They share a premise. Parity with PostgREST v16 is nearly complete and the differential suite keeps it honest
([`PARITY.md`](../PARITY.md)), so what is left to add is not more parity — it is what only a **library** can do, and
what a library owes an application it runs inside of. [`design.md`](design.md) draws that line: ➖ is refused on
purpose, ❌ is not done yet. Everything below is a third thing: considered, and not decided.

- [1. Joining a transaction the application opened](#1-joining-a-transaction-the-application-opened)
- [2. Observability hooks](#2-observability-hooks)
- [3. Guardrails for an exposed surface](#3-guardrails-for-an-exposed-surface)
- [4. A debug mode](#4-a-debug-mode)

## 1. Joining a transaction the application opened

**Done, and not this.** A transaction across several `query()` calls was the first half of this proposal and is now
built: `transaction(fn, ctx)` lends a session to a callback, applies the context once for all of it, commits when the
callback returns and rolls back when it throws or when any query in it failed — see
[`query.md`](query.md#transactions). pg-rest owns the boundary there.

**The harder, separate half.** The same session, the other owner: the scope lends one to your callback, this lends one
to pg-rest.

```ts ignore
await sql.begin(async (tx) => {
  //                                                  postgres.js owns BEGIN, COMMIT and ROLLBACK
  await myOwnStep(tx); //                             your SQL, Drizzle, an outbox row
  const { error } = await pgRest.query(
    { table: "todos", insert: { title: "t" } },
    { role: "authenticated", session: postgresJsSession(tx) }, // and pg-rest writes inside it
  );
  if (error) throw error; //                          your transaction is what rolls back
});
```

Whatever your driver's transaction scope is — `sql.begin` here, `adapter.transaction`, a `pg` client with its own
`BEGIN`/`ROLLBACK`/`COMMIT` — it stays the owner of the boundary, and pg-rest only posts statements inside it.

A driver's transaction handle is not a `DbSession`, hence the wrapper: the `session()` each adapter already builds
internally (`src/adapters/*`) would have to be exported. That part is additive, and so is a `session` the core honours
by running its statements on it instead of calling `adapter.transaction` — `Env.session` already exists, which is what
the scope is built on. What is not additive is everything that follows from not owning the boundary.

**The context leaks forward.** `set_config(…, true)` is transaction-local, which is the whole mechanism: posted in
*your* transaction, it stays there until your `COMMIT`. So the statement after the pg-rest call runs as
`authenticated`, with its claims, its `search_path` and its `timezone` — and pg-rest cannot pop what it pushed. Either
it reads the previous values and restores them (doable, and an approximation: there is a list of settings to get right,
and `RESET` is not the same as the value that was there), or the leak is documented as the price. It is the same leak
[`adapters.md`](adapters.md) warns about — "a request that is not in one would leak its caller into the next" — moved
inside a single transaction.

**Three behaviours stop being honourable**, all three because they are implemented *by* aborting the transaction:

- `Prefer: tx=rollback` and plan output throw `RollbackWith` in order to force a `ROLLBACK`. On a borrowed transaction
  there is nothing to force. They have to be refused in this mode rather than quietly ignored.
- `single` and `maxAffected` (`PGRST116`, `PGRST124`) throw in order to undo the write they just measured. Here the
  write stays, and since `query()` *returns* failures, a caller who logs the `error` and commits anyway has committed
  something the library reported as a failure. They become assertions whose remedy is the caller's: rethrow, so your
  own transaction rolls back. That is the footgun of the whole idea, and it is the one thing the scope *can* answer —
  it refuses to commit after a failed query, because it is the one holding the `COMMIT`.
- `SET TRANSACTION READ ONLY` is refused by PostgreSQL (`25001`) once a statement has been issued, so it has to go.

The serialization retry goes with them: replaying a transaction we did not open is not ours to do.

**And a question of shape.** `RequestContext`'s three fields all say *who* is asking (`role`, `claims`, `settings`); a
session says *where* to run. Putting it there mixes identity with plumbing, and a third argument
(`query(input, ctx, { session })`) would separate them at the cost of one more signature.

What makes it worth any of this: it is the only way a pg-rest query and the application's own SQL land in **one**
atomic unit — a job, a webhook, an outbox — which is what "one process, one pool" in [`design.md`](design.md) promises
and does not yet deliver, and the one thing a PostgREST process can never offer, because it is not in the process.

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
