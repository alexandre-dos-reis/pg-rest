// The client your application code imports: one instance, created once, typed by db.generated.ts.
// Handing the generated type to createQuery is the whole of what makes the queries below check
// themselves -- and it is why this file comes *after* `npm run gen:types`.
//
// The options say `schemas: ["api"]` and nothing more about the schema: the instance reads the
// catalog itself, once, on its first operation. Hand it the `schema` descriptor `generateModule`
// writes instead (see ../with-transactions) and it reads nothing, ever.
import { createQuery } from "@tspg/query";
import { pglite, restOptions } from "./db.ts";
import type { DatabasePgRest } from "./db.generated.ts";

export const rest = createQuery<DatabasePgRest>(restOptions);

export const close = async (): Promise<void> => {
  await rest.close();
  await pglite.close();
};
