import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Settings } from "./settings";
import {
  HttpRouter as Router,
  HttpServer as Server,
  HttpServerResponse as Response,
} from "@effect/platform";
import { createServer } from "http";
import { SchemaCache } from "./SchemaCache";
import { PgClientLive } from "./PgClient";

// Define the router with a single route for the root URL
// https://github.com/Effect-TS/effect/tree/main/packages/platform
const app = Router.empty.pipe(
  Router.get("/", Response.text("Hello World")),
  Router.get(
    "/hello",
    Effect.sync(() => {
      return Response.text("Hello World");
    }),
  ),
  Server.serve(),
  Server.withLogAddress,
);

// Create a server layer with the specified port
const AppLive = Layer.scoped(
  Server.HttpServer,
  Effect.gen(function* () {
    const settings = yield* Settings.get();

    if (settings.mode !== "standalone") {
      return yield* Effect.dieMessage("Settings mode is not Standalone !");
    }

    // SchemaCache is initialized for side effects, but not used directly here
    const schemaCache = yield* SchemaCache;

    return yield* NodeHttpServer.make(() => createServer(), {
      port: settings.port,
    });
  }),
);

const depsLive = Layer.mergeAll(Settings.StandaloneLive, SchemaCache.Default);

NodeRuntime.runMain(
  Layer.launch(Layer.provide(app, AppLive)).pipe(
    Effect.provide([
      Settings.StandaloneLive,
      SchemaCache.Default.pipe(Layer.provide([Settings.StandaloneLive])),
    ]),
  ),
);
