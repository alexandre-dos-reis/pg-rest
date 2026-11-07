// The instance the application imports, created once and typed by db.generated.ts: `table` and `rpc`
// are the ones that exist, and `data` is inferred from the `select` -- inside a transaction too.
import { createQuery } from "@tsql/query";
import { pgRestOptions } from "./db.ts";
import { schema, type DatabasePgRest } from "./db.generated.ts";

export const pgRest = createQuery<DatabasePgRest>({ ...pgRestOptions, schema });

/** The two rows this example moves money between, read outside any scope. */
export const balances = async (): Promise<string> => {
  const { data, error } = await pgRest.query({ table: "accounts", select: ["id", "balance"], order: ["id"] });
  if (error) throw error;
  return data.map((a) => `${a.id} ${a.balance}`).join(", ");
};

export const ledgerCount = async (): Promise<number> => {
  const { count, error } = await pgRest.query({ table: "ledger", select: ["id"], count: "exact" });
  if (error) throw error;
  return count;
};
