// Postgres in WebAssembly (PGlite): no server, no Docker, the schema lives in memory. Everything
// else in this example is the same against a real server -- swap the adapter and keep going.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { createPgRest } from "@adrdp/pg-rest";
import { pgliteAdapter } from "@adrdp/pg-rest/adapters/pglite";

export const pglite = new PGlite();
await pglite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

export const pgRest = await createPgRest({
  db: pgliteAdapter(pglite),
  schemas: ["api"],
  anonymousRole: "anon",
});

/** The two rows this example moves money between, read outside any scope. */
export const balances = async (): Promise<string> => {
  const { data, error } = await pgRest.query<Array<{ id: string; balance: number }>>({
    table: "accounts",
    select: ["id", "balance"],
    order: ["id"],
  });
  if (error) throw error;
  return data.map((a) => `${a.id} ${a.balance}`).join(", ");
};

export const ledgerCount = async (): Promise<number> => {
  const { count, error } = await pgRest.query({ table: "ledger", select: ["id"], count: "exact" });
  if (error) throw error;
  return count ?? 0;
};
