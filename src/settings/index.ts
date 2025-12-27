import { Config, Context, Effect, Layer, Schema } from "effect";
import type { ConfigError } from "effect/ConfigError";
import type { ParseError } from "effect/ParseResult";

const withPrefix = (name: string) => `PGREST_${name}`;

const portSchema = Schema.NumberFromString.pipe(Schema.between(1000, 65_535));

const arraySchema = Schema.transform(
  Schema.String,
  Schema.Array(Schema.String),
  {
    decode: (s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    encode: (arr) => arr.join(","),
  },
);

const PG_URI_SCHEME = /^(postgres|postgresql):\/\/(.+)$/i;
const PG_AUTH_HOST_DB =
  /^(?:([^:@]+)(?::([^@]+))?@)?([^:/?#]+)(?::(\d+))?\/(.+)$/;

const pgUriStructSchema = Schema.Struct({
  user: Schema.UndefinedOr(Schema.String),
  password: Schema.UndefinedOr(Schema.String),
  host: Schema.String,
  port: Schema.Number,
  database: Schema.String,
  uri: Schema.String,
});

const postgresUriSchema = Schema.transform(Schema.String, pgUriStructSchema, {
  strict: true,
  decode: (s) => {
    // check scheme
    const schemeMatch = s.match(PG_URI_SCHEME);
    if (!schemeMatch) {
      throw new Error(
        "Invalid scheme: must be 'postgres://' or 'postgresql://'",
      );
    }

    const rest = schemeMatch[2]; // everything after scheme
    const match = rest?.match(PG_AUTH_HOST_DB);

    if (!match) {
      throw new Error(
        "Invalid Postgres URI, expected format: postgres://user:pass@host:5432/database",
      );
    }

    const [, user, password, host, port, database] = match;

    if (!host) throw new Error("Host is required in Postgres URI");
    if (!database) throw new Error("Database name is required in Postgres URI");
    if (
      port &&
      (!/^\d+$/.test(port) || Number(port) <= 0 || Number(port) > 65535)
    ) {
      throw new Error("Port must be a valid number between 1 and 65535");
    }

    return {
      user: user || undefined,
      password: password || undefined,
      host,
      port: port ? Number(port) : 5432,
      database,
      uri: s,
    };
  },
  encode: (struct) => struct.uri,
});

const libSettingsArgsSchema = Schema.Struct({
  dbUri: Schema.String,
  dbSchemas: Schema.UndefinedOr(Schema.Array(Schema.String)).pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => ["public"] as const),
  ),
  dbAnonymousRole: Schema.UndefinedOr(Schema.String).pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => "anon"),
  ),
});

export type LibSettingsArgs = typeof libSettingsArgsSchema.Type;

const CommonSchema = Schema.Struct({
  ...pgUriStructSchema.fields,
  schemas: Schema.UndefinedOr(Schema.Array(Schema.String)).pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => ["public"] as const),
  ),
  anonymousRole: Schema.UndefinedOr(Schema.String).pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => "anon"),
  ),
});

const StandaloneSettingsSchema = Schema.Struct({
  mode: Schema.Literal("standalone"),
  port: Schema.UndefinedOr(portSchema),
  db: Schema.Struct(CommonSchema.fields),
});

const LibrarySettingsSchema = Schema.Struct({
  mode: Schema.Literal("library"),
  db: Schema.Struct(CommonSchema.fields),
});

const SettingsSchema = Schema.Union(
  StandaloneSettingsSchema,
  LibrarySettingsSchema,
);

export class Settings extends Context.Tag("pg-rest/Settings")<
  Settings,
  (
    args?: typeof libSettingsArgsSchema.Type,
  ) => Effect.Effect<typeof SettingsSchema.Type, ConfigError | ParseError>
>() {}

export const StandaloneSettingsLive = Layer.succeed(Settings, () =>
  Effect.gen(function* () {
    const dbUriStruct = yield* Schema.Config(
      withPrefix("DB_URI"),
      postgresUriSchema,
    );

    const schemas = yield* Schema.Config(
      withPrefix("DB_SCHEMAS"),
      arraySchema,
    ).pipe(Config.withDefault(["public"]));

    const anonymousRole = yield* Schema.Config(
      withPrefix("DB_ANON_ROLE"),
      Schema.String,
    ).pipe(Config.withDefault("anon"));

    const port = yield* Schema.Config(withPrefix("PORT"), portSchema).pipe(
      Config.withDefault(4900),
    );

    return {
      mode: "standalone",
      port,
      db: {
        ...dbUriStruct,
        schemas,
        anonymousRole,
      },
    };
  }),
);

export const LibrarySettingsLive = Layer.succeed(Settings, (args) =>
  Effect.gen(function* () {
    const { dbUri, dbAnonymousRole, dbSchemas } = yield* Schema.decodeUnknown(
      libSettingsArgsSchema,
    )(args);

    const dbUriStruct = yield* Schema.decodeUnknown(postgresUriSchema)(dbUri);

    return {
      mode: "library",
      db: {
        ...dbUriStruct,
        schemas: dbSchemas,
        anonymousRole: dbAnonymousRole,
      },
    };
  }),
);
