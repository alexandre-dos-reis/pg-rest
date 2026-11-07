// The client your application code imports: one instance, created once, typed by db.types.ts.
// Handing the generated type to createQuery is the whole of what makes the queries below check
// themselves -- and it is why this file comes *after* `npm run gen:types`.
import { createQuery } from "@tsql/query";
import { pgRestOptions, pglite } from "./db.ts";
import type { DatabasePgRest } from "./db.types.ts";

export const pgRest = await createQuery<DatabasePgRest>(pgRestOptions);

export const close = async (): Promise<void> => {
  await pgRest.close();
  await pglite.close();
};
