import { Schema } from "effect";

export const portSchema = Schema.NumberFromString.pipe(
  Schema.between(1000, 65_535),
);

export const arraySchema = Schema.transform(
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

export const pgUriStructSchema = Schema.Struct({
  username: Schema.UndefinedOr(Schema.String),
  password: Schema.UndefinedOr(Schema.Redacted(Schema.String)),
  host: Schema.String,
  port: Schema.Number,
  database: Schema.String,
  uri: Schema.String,
});

export const postgresUriSchema = Schema.transform(
  Schema.String,
  pgUriStructSchema,
  {
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

      const [, username, password, host, port, database] = match;

      if (!host) throw new Error("Host is required in Postgres URI");
      if (!database)
        throw new Error("Database name is required in Postgres URI");
      if (
        port &&
        (!/^\d+$/.test(port) || Number(port) <= 0 || Number(port) > 65535)
      ) {
        throw new Error("Port must be a valid number between 1 and 65535");
      }

      return {
        username: username || undefined,
        password: password || undefined,
        host,
        port: port ? Number(port) : 5432,
        database,
        uri: s,
      };
    },
    encode: (struct) => struct.uri,
  },
);

export const libSettingsArgsSchema = Schema.Struct({
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
  port: portSchema,
  db: Schema.Struct(CommonSchema.fields),
});

const LibrarySettingsSchema = Schema.Struct({
  mode: Schema.Literal("library"),
  db: Schema.Struct(CommonSchema.fields),
});

export const SettingsSchema = Schema.Union(
  StandaloneSettingsSchema,
  LibrarySettingsSchema,
);
