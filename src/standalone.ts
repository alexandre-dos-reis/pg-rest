import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Settings } from "./settings";

const program = Effect.gen(function* () {
  const settings = yield* Settings.initInStandaloneMode;
  yield* Console.log(settings);
});

NodeRuntime.runMain(program.pipe(Effect.provide([Settings.Default])));
