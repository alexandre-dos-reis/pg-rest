// The driver, and the options both scripts share. Nothing here depends on the generated types:
// gen-types.ts has to run before they exist.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAdapter } from "@adrdp/pg-rest/adapters/pglite";
// a type, so `import type`: Node strips it, and importing it as a value would fail at runtime
import type { PgRestOptions } from "@adrdp/pg-rest";

// Postgres in WebAssembly: no server, no Docker, the schema lives in memory.
export const pglite = new PGlite();
await pglite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

export const pgRestOptions: PgRestOptions = {
  db: pgliteAdapter(pglite),
  schemas: ["api"],
  anonymousRole: "anon",
  planEnabled: true,
};
