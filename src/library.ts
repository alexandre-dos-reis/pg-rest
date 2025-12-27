import { Effect } from "effect";
import { Settings } from "./settings";

type Args = NonNullable<Parameters<typeof Settings.get>[0]>;

const initProgram = (args: Args) =>
  Effect.gen(function* () {
    const settings = yield* Settings.get(args);
    if (settings.mode !== "library") {
      return yield* Effect.dieMessage("Settings mode is not Library !");
    }
    return {
      handler: (request: Request): Response | Promise<Response> => {
        return new Response();
      },
    };
  });

export const pgRest = async (args: Args) => {
  const { handler } = await Effect.runPromise(
    initProgram(args).pipe(Effect.provide([Settings.LibraryLive])),
  );
  return {
    handler,
  };
};
