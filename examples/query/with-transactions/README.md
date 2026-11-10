# pg-rest with transactions

Money moving between two accounts: a debit, a credit and the row that says it happened — three
writes that have to land together or not at all. No server and no HTTP, because this is the half of
pg-rest a REST process cannot offer: `transaction()` lends a transaction to **your** callback.

```sh
bun install
bun run gen:types   # read the catalog, write db.generated.ts
bun start           # seven scopes, one process
bun run typecheck
```

It runs on **Bun** over PGlite, which keeps Postgres in-process — nothing to install, nothing to
start. Everything here is identical against a real server: swap the adapter in `db.ts`, load
`schema.sql` with `psql`, and keep going.

`pg-rest` is an ordinary versioned dependency, so once this folder is copied out of the repository
the install above is all you need. Inside the repository that version is not on the registry yet,
so link the local build instead — from the repository root:

```sh
bun run link:examples with-transactions
```

## What it prints

```
1 committed ledger #1 -> alice-main 60, bob-main 140
2 refused 23514 invalid_data -> alice-main 60, bob-main 140
3 rls 42501 forbidden -> alice-main 60, bob-main 140
4 batch kept 2 refused b (23514) -> alice-main 75, bob-main 125
5 dry run PGRSTX02 ledger 3 -> 3
6 report held 200 moved 55
7 no context PGRSTX01 no_context
```

Line 2 is the point of the whole example: the debit was refused by a `CHECK`, so the credit that
followed it and the ledger row never happened — the balances are exactly what they were.

## The files

**`schema.sql`** — two accounts, a ledger, `CHECK (balance >= 0)` as the database's last word, and a
Row Level Security policy that lets a member record a transfer only out of their own account.

**`db.ts`** and **`gen-types.ts`** — PGlite, the schema loaded in memory, the options, and the
generator that writes `db.generated.ts` from the catalog (`bun run gen:types`, again after a migration):
one call, `generateModule(options)`, on the same options the instance is created from. It writes the
types *and* the `schema` descriptor, which this example hands to `createQuery` so that nothing reads
the catalog at runtime. See [`with-generated-types`](../with-generated-types) for what that file looks
like, and for the other way round: no descriptor, and the catalog read once on the first query.

**`client.ts`** — the instance, typed by it: `createQuery<DatabasePgRest>(options)`. That one type
argument reaches inside the scopes too, which is why nothing below declares a row shape.

**`context.ts`** — who is asking, read from an `AsyncLocalStorage`:

```ts
const store = new AsyncLocalStorage<RequestContext>();

export const pgQuery = pgRest.setContextQuery(() => store.getStore());

export const asUser = <T>(sub: string, fn: () => Promise<T>): Promise<T> =>
  store.run({ role: "member", claims: { sub } }, fn);
```

pg-rest holds no store of its own, which is what leaves it dependency-free and lets the context come
from anywhere — `node:async_hooks` here, a per-request store your framework already has, a fixed
context for a job. `pgQuery.select(input)` reads the store at **every** call, so one bound query serves a
different caller for every request in flight; a scope reads it **once, on entry**, because a
transaction has one `set_config` and a store answering differently halfway through could not be
honoured anyway.

Use `store.run`, not `store.enterWith`: `run` is bounded by its callback.

**`transfers.ts`** — the application code, which is the part worth reading. It runs queries and
mentions no role, no claims and no user id; nothing is threaded through its signatures:

```ts
const move = async (tx: Tx, t: Transfer): Promise<number> => {
  const { data: accounts } = await tx.select({ table: "accounts", columns: ["id", "balance"], where: { … } });
  //    ^ Array<{ id: string; balance: number }> -- typed, and not `| null`
  …
};

export const transfer = (t: Transfer) =>
  pgQuery.transaction((tx) => move(tx, t), {
    isolationLevel: "repeatable read",
    retry: { attempts: 3, delayMs: 10 },
  });
```

Those options name no `role`, `claims` or `settings`, so the ambient context stays in place: they
belong to the transaction, not to the caller. (Naming a role there *would* replace it for the whole
scope — the per-call override, moved to the granularity `set_config` works at.)

**`main.ts`** — the seven scopes, each `asUser("alice", …)` or `asUser("bob", …)`.

## What each scope shows

**1. Three writes, one transaction.** A scope's operations differ from the instance's in exactly two ways. It takes
no context — the role and the claims are transaction-local and issued once at the head of the
transaction, so a per-call context would change the role for every statement that follows instead of
scoping anything. And it rejects on failure instead of answering an `error`, which is why `move()`
in `transfers.ts` has no error handling at all: what is left is the happy path, with `data` already
narrowed.

**2. A rollback, from the database's own refusal.** The debit is refused by the `CHECK`, so that
query leaves the scope and the scope rolls back. Even a callback that *caught* it could not commit:
`single` and `maxAffected` are checks raised *after* a statement that worked, and a scope that
committed on the callback's return value would keep the row while reporting it as refused.

**3. The claims apply to the whole scope.** Bob gets as far as the ledger row and no further: the
policy reads the claims that were set once, on entry, and the two balance updates are undone with
it.

**4. One transfer allowed to fail: `tx.transaction()`.** A nested scope is a `SAVEPOINT`, and the one
place a transaction may carry on after a failure — so unlike an operation of `tx` it answers a `QueryResult`
rather than rejecting. The batch reads that `error`, keeps the two transfers that worked, and still
commits them: one transaction, three savepoints.

**5. `tx.rollback()`.** Do the work, measure it, decline to keep it. The scope's `error` is
`PGRSTX02`, kind `"rolled_back"`.

**6. `readOnly` and `isolationLevel`.** Both are per-transaction, so the scope decides them rather
than whichever query went first — and they go in as the transaction's first statement, which is the
only place PostgreSQL accepts them. A report that cannot write, over a snapshot that cannot be read
half-written.

**7. No context is an error, not the anonymous role.** Outside the store the scope is refused
*before* the `BEGIN`: `PGRSTX01`. Falling back to `anon` would turn a missing middleware into a
silent change of privileges — the kind of bug that reads as "empty result" in development and as an
incident in production.

## About the retry

`transfer()` reads a balance and writes it back, which is a lost update waiting to happen if two of
them run at once. Hence `isolationLevel: "repeatable read"`, under which PostgreSQL refuses the
second writer with a serialization failure (`40001`) instead of losing the update — and
`retry: { attempts: 3 }`, which replays the scope when it happens.

Retrying is off by default and asked for here, because replaying the transaction means replaying
*your callback*: what else it does — a counter, an email, a write through another driver — is not
the library's to repeat. PGlite holds a single connection, so this example cannot show two scopes
racing; against a real server the second one gets its `40001` and the replay wins.

## Where to look next

[`docs/query.md`](../../../docs/query.md#transactions) is the reference for scopes, and
[`docs/query.md#binding-it-once`](../../../docs/query.md#binding-it-once) for the ambient context. The
other examples add a server and HTTP ([`with-pglite`](../../rest/with-pglite),
[`with-node-postgres`](../../rest/with-node-postgres)) and a real sign-in
([`with-better-auth`](../../rest/with-better-auth)). Joining a transaction your *application* opened is the
half that is not built: [`docs/proposals.md`](../../../docs/proposals.md).
