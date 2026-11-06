// Step 1: write the types. Run it again after a migration.
//   bun gen-types.ts
//
// It builds its own, untyped instance: the generator cannot be typed by the file it is about to
// write, which is also why it imports db.ts and not client.ts.
import { writeFileSync } from "node:fs";
import { createPgRest } from "@adrdp/pg-rest";
import { pgRestOptions, pglite } from "./db.ts";

const pgRest = await createPgRest(pgRestOptions);
const types = await pgRest.generateTypes({ name: "DatabasePgRest" });

writeFileSync(new URL("./db.types.ts", import.meta.url), types);
console.log(`db.types.ts: ${types.split("\n").length} lines`);

await pgRest.close();
await pglite.close();
