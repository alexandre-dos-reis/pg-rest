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

**The shape.** One scope, one transaction, one `set_config` of the context, rollback on a throw:

```ts ignore
const { data, error } = await pgRest.transaction(async (tx) => {
  const { data: order } = await tx({ table: "orders", insert: { client_id: 1 }, single: true });
  await tx({ table: "order_lines", insert: linesFor(order.id) });
  return order;
}, { role: "authenticated", claims: { sub: user.id } });
```

`tx` is a `ContextQuery` — the type `setContextQuery` already returns — so nothing new has to be learned to use it, and
the context is applied once for the scope rather than per call. A failed query inside the scope is still returned, not
thrown; what rolls the transaction back is the callback throwing, which is the discipline every driver already has.

**The harder, more valuable half.** Accepting a session the application already holds, so a pg-rest query *joins* a
transaction it did not open:

```ts ignore
await pool.transaction(async (session) => {
  await myOwnMigrationStep(session);
  await pgRest.query({ table: "todos", insert: { title: "t" } }, { role: "authenticated", session });
});
```

That is what makes the layer composable with the rest of the codebase — Drizzle, a job runner, a `pg` transaction in a
webhook — and it is the one thing a PostgREST process can never offer, because it is not in the process. It needs
`DbAdapter` to expose a session as a first-class value rather than only inside `transaction(fn)`, which is a breaking
change to the adapter contract ([`adapters.md`](adapters.md)) and the reason this is a proposal and not a patch.

**Open questions.** Whether `Prefer: tx=rollback` and the `maxRows` cap compose sensibly inside a user-held
transaction; what a nested `transaction` call does; and whether the serialization-failure retry (up to 2 on `40001`)
can survive at all once the transaction is not ours to replay.

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
