// Step 1: write the types. Run it again after a migration.
//   node gen-types.ts
//
// One call on the options createQuery takes: it reads the catalog and gives back the module text, so
// the types describe exactly the database the instance will run against. It imports db.ts and not
// client.ts, which needs the file this one is about to write.
//
// `generateModule` writes a `schema` descriptor beside the types; hand that to `createQuery` and the
// running application reads no catalog at all. ../with-transactions does it that way.
import { writeFileSync } from "node:fs";
import { generateTypes } from "@tspg/query/types";
import { restOptions, pglite } from "./db.ts";

const generated = await generateTypes(restOptions, { name: "DatabasePgRest" });

writeFileSync(new URL("./db.generated.ts", import.meta.url), generated);
console.log(`db.generated.ts: ${generated.split("\n").length} lines`);

await pglite.close();
