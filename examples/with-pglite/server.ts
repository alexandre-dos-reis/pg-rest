import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server"; // only used to turn Node's http into Request/Response
import { PGlite } from "@electric-sql/pglite";
import { createPgRest } from "pg-rest";
import { pgliteAdapter } from "pg-rest/adapters/pglite";

// Postgres running in-process (WebAssembly): no server, no Docker. Data lives in memory.
const db = new PGlite();
await db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

const pgRest = await createPgRest({
  db: pgliteAdapter(db),
  schemas: ["api"],
  anonymousRole: "anon",
  resolveContext: (req) => {
    // Replace this with your real auth: session cookie, API key, ... (there is no JWT).
    const user = req.headers.get("x-user");
    return user ? { role: "authenticated", claims: { sub: user } } : undefined; // undefined -> "anon"
  },
});

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: (req) => pgRest.handle(req), port });
console.log(`pg-rest (PGlite) listening on http://localhost:${port}`);

process.on("SIGINT", async () => {
  server.close();
  await pgRest.close();
  await db.close();
  process.exit(0);
});
