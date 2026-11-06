// Seven scopes, one process:  bun main.ts
//
// Everything below goes through `pgQuery.transaction`, which reads who is asking from the
// AsyncLocalStorage in context.ts -- so not one call here passes a role or a claim.
import { balances, ledgerCount, pgRest, pglite } from "./db.ts";
import { asUser } from "./context.ts";
import { batch, dryRun, report, transfer } from "./transfers.ts";

// 1. The happy path: debit, credit and the ledger row, or none of the three.
await asUser("alice", async () => {
  const { data, error } = await transfer({ payer: "alice-main", payee: "bob-main", amount: 40, memo: "rent" });
  if (error) throw error;
  console.log(`1 committed ledger #${data} -> ${await balances()}`);
});

// 2. An overdraft. The debit is refused by the CHECK (23514), so the credit that followed it and
//    the ledger row never happen: the balances are exactly what they were.
await asUser("alice", async () => {
  const { error } = await transfer({ payer: "alice-main", payee: "bob-main", amount: 1000, memo: "yacht" });
  console.log(`2 refused ${error?.body.code} ${error?.kind} -> ${await balances()}`);
});

// 3. The claims are set once, at the head of the transaction, and RLS reads them for the whole of
//    it. Bob moving money out of Alice's account gets as far as the ledger row, and no further:
//    the two balance updates are undone with it.
await asUser("bob", async () => {
  const { error } = await transfer({ payer: "alice-main", payee: "bob-main", amount: 10, memo: "helping myself" });
  console.log(`3 rls ${error?.body.code} ${error?.kind} -> ${await balances()}`);
});

// 4. A batch in one transaction, each transfer in its own savepoint: the middle one overdraws and
//    is undone on its own, the other two commit.
await asUser("bob", async () => {
  const { data, error } = await batch([
    { payer: "bob-main", payee: "alice-main", amount: 10, memo: "a" },
    { payer: "bob-main", payee: "alice-main", amount: 9000, memo: "b" },
    { payer: "bob-main", payee: "alice-main", amount: 5, memo: "c" },
  ]);
  if (error) throw error;
  console.log(`4 batch kept ${data.kept.length} refused ${data.refused.join(" ")} -> ${await balances()}`);
});

// 5. A dry run: the work is done, measured, and then declined.
await asUser("alice", async () => {
  const before = await ledgerCount();
  const { error } = await dryRun({ payer: "alice-main", payee: "bob-main", amount: 1, memo: "just looking" });
  console.log(`5 dry run ${error?.body.code} ledger ${before} -> ${await ledgerCount()}`);
});

// 6. A read-only, serializable snapshot: nothing in it can write, by construction.
await asUser("alice", async () => {
  const { data, error } = await report();
  if (error) throw error;
  console.log(`6 report held ${data.held} moved ${data.moved}`);
});

// 7. Outside the store there is no context to read, so the scope is refused *before* the BEGIN --
//    rather than quietly running as the anonymous role, which is how a missing middleware becomes
//    an incident instead of an error.
const forgotten = await transfer({ payer: "alice-main", payee: "bob-main", amount: 1 });
console.log(`7 no context ${forgotten.error?.body.code} ${forgotten.error?.kind}`);

await pgRest.close();
await pglite.close();
