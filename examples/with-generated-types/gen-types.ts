// Step 1: write the types. Run it again after a migration.
//   node gen-types.ts
//
// It reads the catalog once, here, and writes the types and the schema `createQuery` runs on: the
// running application never reads the catalog. It imports db.ts and not client.ts, which needs the
// file this one is about to write.
import { writeFileSync } from "node:fs";
import { generateModule, introspect } from "@tsql/query/types";
import { pgRestOptions, pglite, schemas } from "./db.ts";

const generated = generateModule(await introspect(pgRestOptions.db, schemas), { name: "DatabasePgRest" });

writeFileSync(new URL("./db.generated.ts", import.meta.url), generated);
console.log(`db.generated.ts: ${generated.split("\n").length} lines`);

await pglite.close();
