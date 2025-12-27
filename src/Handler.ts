import { Effect } from "effect";
import SchemaCache from "./SchemaCache";

export class Handler extends Effect.Service<Handler>()("pg-rest/Handler", {
  dependencies: [SchemaCache.Default],
  effect: Effect.gen(function* () {
    return {};
  }),
}) {}
