import { PgClient } from "@effect/sql-pg";
import { Effect, Layer } from "effect";
import { Settings } from "./settings";

export const PgClientLive = Layer.scoped(
  PgClient.PgClient,
  Effect.gen(function* () {
    const {
      db: { database, host, password, port, username },
    } = yield* Settings.get();

    return yield* PgClient.make({
      host,
      port,
      database,
      username,
      password,
    });
  }),
);
