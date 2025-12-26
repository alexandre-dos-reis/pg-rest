import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Settings } from "./settings";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const settings = yield* Settings.initWithStandaloneMode;

    yield* Console.log(settings);
  }).pipe(Effect.provide([Settings.Default])),
);
