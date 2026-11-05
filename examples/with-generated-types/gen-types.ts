// Step 1: write the types. Run it again after a migration.
//   node gen-types.ts
import { writeFileSync } from "node:fs";
import { generateTypes } from "@adrdp/pg-rest/types";
import { pgRest, pglite } from "./db.ts";

// schemaCache() is the introspected catalog -- the same one the library reads to answer a request,
// so the types describe exactly what it accepts.
const types = generateTypes(await pgRest.schemaCache(), { name: "DatabasePgRest" });

writeFileSync(new URL("./db.types.ts", import.meta.url), types);
console.log(`db.types.ts: ${types.split("\n").length} lines`);

await pgRest.close();
await pglite.close();
