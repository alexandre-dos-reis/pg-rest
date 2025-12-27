import { Effect } from "effect";
import {
  LibrarySettingsLive,
  Settings,
  type LibSettingsArgs,
} from "./settings";

const initProgram = (args: LibSettingsArgs) =>
  Effect.gen(function* () {
    const settings = yield* (yield* Settings)(args);

    return {
      handler: (request: Request): Response | Promise<Response> => {
        return new Response();
      },
    };
  });

export const pgRest = async (args: LibSettingsArgs) => {
  const { handler } = await Effect.runPromise(
    initProgram(args).pipe(Effect.provide([LibrarySettingsLive])),
  );
  return {
    handler,
  };
};
