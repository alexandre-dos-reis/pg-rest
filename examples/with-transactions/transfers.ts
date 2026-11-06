// Application code. It runs queries and knows nothing about who is asking: no role, no claims, no
// user id, no `ctx` threaded through its signatures. That is what the AsyncLocalStorage in
// context.ts is for -- and a transaction reads it once, on entry.
import type { Transaction } from "@adrdp/pg-rest";
import { pgQuery } from "./context.ts";

export interface Transfer {
  readonly payer: string;
  readonly payee: string;
  readonly amount: number;
  readonly memo?: string;
}

interface Account {
  readonly id: string;
  readonly balance: number;
}

/**
 * The three writes that have to land together: the debit, the credit, and the row that says it
 * happened. Every failure is rethrown, which is what rolls the scope back -- and a scope that
 * reaches the end with an `error` it ignored would not commit either.
 */
const move = async (tx: Transaction, t: Transfer): Promise<number> => {
  const read = await tx.query<Account[]>({
    table: "accounts",
    select: ["id", "balance"],
    where: { id: ["in", [t.payer, t.payee]] },
  });
  if (read.error) throw read.error;
  const payer = read.data.find((a) => a.id === t.payer);
  const payee = read.data.find((a) => a.id === t.payee);
  if (!payer || !payee) throw new Error(`no such account: ${t.payer} -> ${t.payee}`);

  // The balance is read here and written back below, which is a lost update waiting to happen if
  // two of these run at once -- hence the isolation level and the retry declared at the scope.
  const debit = await tx.query({
    table: "accounts",
    action: "update",
    set: { balance: payer.balance - t.amount },
    where: { id: t.payer },
  });
  if (debit.error) throw debit.error; //   23514: the CHECK refuses an overdrawn account

  const credit = await tx.query({
    table: "accounts",
    action: "update",
    set: { balance: payee.balance + t.amount },
    where: { id: t.payee },
  });
  if (credit.error) throw credit.error;

  const row = await tx.query<{ id: number }>({
    table: "ledger",
    action: "insert",
    rows: { payer: t.payer, payee: t.payee, amount: t.amount, memo: t.memo ?? null },
    single: true,
  });
  if (row.error) throw row.error; //       42501: the policy only allows your own account
  return row.data.id;
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
 * that transfer and comes back as its `error`, and the ones that worked still commit at the end.
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
      const accounts = await tx.query<Account[]>({ table: "accounts", select: ["id", "balance"] });
      if (accounts.error) throw accounts.error;
      const moved = await tx.query<Array<{ amount: number }>>({ table: "ledger", select: ["amount"] });
      if (moved.error) throw moved.error;
      return {
        held: accounts.data.reduce((n, a) => n + a.balance, 0),
        moved: moved.data.reduce((n, l) => n + l.amount, 0),
      };
    },
    { readOnly: true, isolationLevel: "serializable" },
  );
