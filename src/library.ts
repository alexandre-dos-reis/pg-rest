import { Effect } from "effect";
import { Settings } from "./settings";

type Args = Parameters<typeof Settings.initInLibraryMode>[number];

const program = (args: Args) =>
  Effect.gen(function* () {
    const settings = Settings.initInLibraryMode(args);
  });

export const pgRest = (args: Args) => {
  const some = Effect.runPromiseExit(program(args));
  return {
    handler: (request: Request): Response | Promise<Response> => {
      return new Response();
    },
  };
};
