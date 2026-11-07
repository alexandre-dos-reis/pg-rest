// Step 1: write the types. Run it again after a migration.
//   node gen-types.ts
//
// It builds its own, untyped instance: the generator cannot be typed by the file it is about to
// write, which is also why it imports db.ts and not client.ts.
import { writeFileSync } from "node:fs";
import { createQuery } from "@tsql/query";
import { pgRestOptions, pglite } from "./db.ts";

const pgRest = await createQuery(pgRestOptions);

// The types come from the catalog the instance already read to answer requests, so they describe
// exactly what it accepts. The generator itself is loaded only by this call.
const types = await pgRest.generateTypes({ name: "DatabasePgRest" });

writeFileSync(new URL("./db.types.ts", import.meta.url), types);
console.log(`db.types.ts: ${types.split("\n").length} lines`);

await pgRest.close();
await pglite.close();
