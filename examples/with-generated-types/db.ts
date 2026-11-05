// Postgres in WebAssembly: no server, no Docker, the schema lives in memory.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAdapter } from "@adrdp/pg-rest/adapters/pglite";
import { createPgRest } from "@adrdp/pg-rest";
import { type DatabasePgRest } from "./db.types";

export const pglite = new PGlite();
await pglite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

export const pgRest = await createPgRest<DatabasePgRest>({
  db: pgliteAdapter(pglite),
  schemas: ["api"],
  anonymousRole: "anon",
});
