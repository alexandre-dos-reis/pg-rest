import { Effect } from "effect";
import { Settings, type LibSettingsArgs } from "./settings";

const program = (args: LibSettingsArgs) =>
  Effect.gen(function* () {
    const settings = (yield* Settings)(args);
  });

export const pgRest = (args: LibSettingsArgs) => {
  // const some = Effect.runPromiseExit(program(args));
  return {
    handler: (request: Request): Response | Promise<Response> => {
      return new Response();
    },
  };
};
