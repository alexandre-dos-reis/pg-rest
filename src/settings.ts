import { Config, Effect, Schema } from "effect";

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

export const postgresUriSchema = Schema.transform(
  Schema.String,
  Schema.Struct({
    scheme: Schema.String,
    user: Schema.UndefinedOr(Schema.String),
    password: Schema.UndefinedOr(Schema.String),
    host: Schema.String,
    port: Schema.Number,
    database: Schema.String,
    raw: Schema.String,
  }),
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
          "Invalid Postgres URI: expected format postgres://user:pass@host:port/db",
        );
      }

      const [, user, password, host, port, database] = match;

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
        scheme: schemeMatch[1] || "postgres",
        user: user || undefined,
        password: password || undefined,
        host,
        port: port ? Number(port) : 5432,
        database,
        raw: s,
      };
    },
    encode: (struct) => struct.raw,
  },
);

export class Settings extends Effect.Service<Settings>()("pg-rest/Settings", {
  accessors: true,
  sync: () => ({
    initWithLibraryMode: ({
      dbUri,
      dbSchemas = ["public"],
      dbAnonRole = "anon",
    }: {
      dbUri: string;
      dbSchemas?: Array<string>;
      dbAnonRole?: string;
    }) =>
      Effect.gen(function* () {
        const { raw, ...dbUriStruct } =
          yield* Schema.decodeUnknown(postgresUriSchema)(dbUri);

        const schemas = yield* Schema.decodeUnknown(arraySchema)(dbSchemas);
        const anonymousRole = yield* Schema.decodeUnknown(Schema.String)(
          dbAnonRole,
        );

        return {
          __mode__: "library" as const,
          db: {
            uri: raw,
            ...dbUriStruct,
            schemas,
            anonymousRole,
          },
        };
      }),
    initWithStandaloneMode: Effect.gen(function* () {
      const {
        raw,
        scheme: _,
        ...dbUriStruct
      } = yield* Schema.Config(withPrefix("DB_URI"), postgresUriSchema);

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
        port,
        db: {
          uri: raw,
          ...dbUriStruct,
          schemas,
          anonymousRole,
        },
        __mode__: "standalone" as const,
      };
    }),
  }),
}) {}
