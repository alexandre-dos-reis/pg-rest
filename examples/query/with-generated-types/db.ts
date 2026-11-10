// The driver, and the options both scripts share. Nothing here depends on the generated types:
// gen-types.ts has to run before they exist.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAdapter } from "@tspg/query/adapters/pglite";
// a type, so `import type`: Node strips it, and importing it as a value would fail at runtime
import type { QueryOptions } from "@tspg/query";

// Postgres in WebAssembly: no server, no Docker, the schema lives in memory.
export const pglite = new PGlite();
await pglite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

// Everything createQuery takes: the driver, the role an anonymous call gets, and the Postgres
// schema to expose. gen-types.ts reads the catalog through this same object, so the types and the
// instance cannot end up describing different schemas.
export const restOptions: QueryOptions = {
  db: pgliteAdapter(pglite),
  anonymousRole: "anon",
  schemas: ["api"],
};
