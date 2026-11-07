// The driver, and the options both scripts share. Nothing here depends on the generated types:
// gen-types.ts has to run before they exist.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAdapter } from "@tsql/query/adapters/pglite";
// a type, so `import type`: Node strips it, and importing it as a value would fail at runtime
import type { QueryOptions } from "@tsql/query";

// Postgres in WebAssembly: no server, no Docker, the schema lives in memory.
export const pglite = new PGlite();
await pglite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

// Everything createQuery takes except the schema, which gen-types.ts writes.
export const pgRestOptions: Omit<QueryOptions, "schema"> = {
  db: pgliteAdapter(pglite),
  anonymousRole: "anon",
};

export const schemas = ["api"];
