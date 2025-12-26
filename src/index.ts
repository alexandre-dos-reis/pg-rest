import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Settings } from "./settings";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const settings = yield* Settings;
    const some = yield* settings.initInStandaloneMode;
    yield* Console.log(settings.db);
  }).pipe(Effect.provide([Settings.Default])),
);
