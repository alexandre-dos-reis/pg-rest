import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Settings } from "./settings";
import {
  HttpRouter as Router,
  HttpServer as Server,
  HttpServerResponse as Response,
} from "@effect/platform";
import { createServer } from "http";

// Define the router with a single route for the root URL
// https://github.com/Effect-TS/effect/tree/main/packages/platform
const router = Router.empty.pipe(
  Router.get("/", Response.text("Hello World")),
  Router.get(
    "/hello",
    Effect.sync(() => {
      return Response.text("Hello World");
    }),
  ),
);

// Set up the application server with logging
const app = router.pipe(Server.serve(), Server.withLogAddress);

// Create a server layer with the specified port
const ServerLive = Layer.scoped(
  Server.HttpServer,
  Effect.gen(function* () {
    const settings = yield* Settings.get();

    if (settings.mode !== "standalone") {
      throw new Error("Invalid mode");
    }

    return yield* NodeHttpServer.make(() => createServer(), {
      port: settings.port,
    });
  }),
);

NodeRuntime.runMain(
  Layer.launch(Layer.provide(app, ServerLive)).pipe(
    Effect.provide(Settings.StandaloneLive),
  ),
);
