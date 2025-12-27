import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Settings, StandaloneSettingsLive } from "./settings";

const program = Effect.gen(function* () {
  const settings = yield* (yield* Settings)();
  yield* Console.log(settings);
});

NodeRuntime.runMain(program.pipe(Effect.provide(StandaloneSettingsLive)));
