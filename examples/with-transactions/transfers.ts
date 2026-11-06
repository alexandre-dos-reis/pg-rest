// Application code. It runs queries and knows nothing about who is asking: no role, no claims, no
// user id, no `ctx` threaded through its signatures. That is what the AsyncLocalStorage in
// context.ts is for -- and a transaction reads it once, on entry.
import type { TypedTransaction } from "@adrdp/pg-rest";
import type { DatabasePgRest } from "./db.types.ts";
import { pgQuery } from "./context.ts";

type Tx = TypedTransaction<DatabasePgRest>;

export interface Transfer {
  readonly payer: string;
  readonly payee: string;
  readonly amount: number;
  readonly memo?: string;
}

/**
 * The three writes that have to land together: the debit, the credit, and the row that says it
 * happened.
 *
 * There is no error handling here, and that is the design rather than an omission. `tx.query`
 * rejects when a query fails, because a query that failed is a transaction that will not commit --
 * so the scope catches it, rolls everything back and answers with it. What is left is the happy
 * path, with `data` already narrowed: the failures are named in the comments, and handled by the
 * caller choosing to read the scope's `error`.
 */
const move = async (tx: Tx, t: Transfer): Promise<number> => {
  const { data: accounts } = await tx.query({
    table: "accounts",
    select: ["id", "balance"],
    where: { id: ["in", [t.payer, t.payee]] },
  });
  const payer = accounts.find((a) => a.id === t.payer);
  const payee = accounts.find((a) => a.id === t.payee);
  if (!payer || !payee) throw new Error(`no such account: ${t.payer} -> ${t.payee}`);

  // The balance is read here and written back below, which is a lost update waiting to happen if
  // two of these run at once -- hence the isolation level and the retry declared at the scope.
  await tx.query({
    table: "accounts",
    action: "update",
    set: { balance: payer.balance - t.amount }, //  23514: the CHECK refuses an overdrawn account
    where: { id: t.payer },
  });
  await tx.query({
    table: "accounts",
    action: "update",
    set: { balance: payee.balance + t.amount },
    where: { id: t.payee },
  });

  const { data: row } = await tx.query({
    table: "ledger",
    action: "insert",
    rows: { payer: t.payer, payee: t.payee, amount: t.amount, memo: t.memo ?? null },
    single: true, //                               42501: the policy only allows your own account
  });
  return row.id;
};

/**
 * One transfer, one transaction. The options name no `role`, `claims` or `settings`, so the
 * ambient context stays in place: these two belong to the transaction, not to the caller.
 */
export const transfer = (t: Transfer) =>
  pgQuery.transaction((tx) => move(tx, t), {
    isolationLevel: "repeatable read",
    retry: { attempts: 3, delayMs: 10 },
  });

/**
 * A batch, in **one** transaction, with each transfer in a savepoint of its own: a refusal undoes
 * that transfer and comes back as its `error` -- the one place a transaction may carry on after a
 * failure -- and the ones that worked still commit at the end.
 */
export const batch = (list: ReadonlyArray<Transfer>) =>
  pgQuery.transaction(async (tx) => {
    const kept: number[] = [];
    const refused: string[] = [];
    for (const t of list) {
      const one = await tx.transaction((nested) => move(nested, t));
      if (one.error) refused.push(`${t.memo ?? "?"} (${one.error.body.code})`);
      else kept.push(one.data);
    }
    return { kept, refused };
  });

/** Do the whole thing, then decline to keep it: `rollback()` leaves the scope with nothing done. */
export const dryRun = (t: Transfer) =>
  pgQuery.transaction(async (tx) => {
    const id = await move(tx, t);
    tx.rollback(); //                      everything above is undone; `id` never comes back
    return id;
  });

/** A snapshot that cannot be read half-written, from a transaction that cannot write at all. */
export const report = () =>
  pgQuery.transaction(
    async (tx) => {
      const { data: accounts } = await tx.query({ table: "accounts", select: ["balance"] });
      const { data: moved } = await tx.query({ table: "ledger", select: ["amount"] });
      return {
        held: accounts.reduce((n, a) => n + a.balance, 0),
        moved: moved.reduce((n, l) => n + l.amount, 0),
      };
    },
    { readOnly: true, isolationLevel: "serializable" },
  );
