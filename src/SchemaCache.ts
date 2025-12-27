import { Effect } from "effect";
import { PgClient } from "@effect/sql-pg";

export class SchemaCache extends Effect.Service<SchemaCache>()(
  "pg-rest/SchemaCache",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      return {
        loadCache: () => sql`Select * from users`,
      };
    }),
  },
) {}
