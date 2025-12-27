import { Config, Context, Effect, Layer, Schema } from "effect";
import {
  libSettingsArgsSchema,
  SettingsSchema,
  portSchema,
  postgresUriSchema,
  arraySchema,
} from "./schemas";

export class Settings extends Context.Tag("pg-rest/Settings")<
  Settings,
  {
    get: (
      args?: typeof libSettingsArgsSchema.Type,
    ) => Effect.Effect<typeof SettingsSchema.Type>;
  }
>() {
  static get(args?: typeof libSettingsArgsSchema.Type) {
    return Effect.flatMap(this, (settings) => settings.get(args));
  }

  static withPrefix = (name: string) => `PGREST_${name}`;

  static StandaloneLive = Layer.sync(this, () => ({
    get: () =>
      Effect.gen(function* () {
        const dbUriStruct = yield* Schema.Config(
          Settings.withPrefix("DB_URI"),
          postgresUriSchema,
        );

        const schemas = yield* Schema.Config(
          Settings.withPrefix("DB_SCHEMAS"),
          arraySchema,
        ).pipe(Config.withDefault(["public"]));

        const anonymousRole = yield* Schema.Config(
          Settings.withPrefix("DB_ANON_ROLE"),
          Schema.String,
        ).pipe(Config.withDefault("anon"));

        const port = yield* Schema.Config(
          Settings.withPrefix("PORT"),
          portSchema,
        ).pipe(Config.withDefault(4900));

        return {
          mode: "standalone" as const,
          port,
          db: {
            ...dbUriStruct,
            schemas,
            anonymousRole,
          },
        };
      }).pipe(Effect.orDieWith((configError) => configError.message)),
  }));

  static LibraryLive = Layer.sync(this, () => ({
    get: (args) =>
      Effect.gen(function* () {
        const { dbUri, dbAnonymousRole, dbSchemas } =
          yield* Schema.decodeUnknown(libSettingsArgsSchema)(args);

        const dbUriStruct =
          yield* Schema.decodeUnknown(postgresUriSchema)(dbUri);

        return {
          mode: "library" as const,
          db: {
            ...dbUriStruct,
            schemas: dbSchemas,
            anonymousRole: dbAnonymousRole,
          },
        };
      }).pipe(Effect.orDieWith((parseError) => parseError.message)),
  }));
}
