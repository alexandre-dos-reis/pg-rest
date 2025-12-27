import { Effect } from "effect";
import { Settings } from "./settings";

export class SchemaCache extends Effect.Service<SchemaCache>()(
  "pg-rest/SchemaCache",
  {
    dependencies: [Settings.Default],
    effect: Effect.gen(function* () {
      const settings = yield Settings.

      return {};
    }),
  },
) {}
