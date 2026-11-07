// The driver, and the options both scripts share. Nothing here depends on the generated types:
// gen-types.ts has to run before they exist.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAdapter } from "@tsql/query/adapters/pglite";
import type { QueryOptions } from "@tsql/query";

// Postgres in WebAssembly: no server, no Docker, the schema lives in memory. Everything else in
// this example is the same against a real server -- swap the adapter and keep going.
export const pglite = new PGlite();
await pglite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

export const pgRestOptions: QueryOptions = {
  db: pgliteAdapter(pglite),
  schemas: ["api"],
  anonymousRole: "anon",
};
