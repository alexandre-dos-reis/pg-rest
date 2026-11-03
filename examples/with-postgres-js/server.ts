import { serve } from "@hono/node-server"; // only used to turn Node's http into Request/Response
import postgres from "postgres";
import { createPgRest } from "pg-rest";
import { postgresJsAdapter } from "pg-rest/adapters/postgres-js";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres");

const pgRest = await createPgRest({
  db: postgresJsAdapter(sql),
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
console.log(`pg-rest (postgres.js) listening on http://localhost:${port}`);

process.on("SIGINT", async () => {
  server.close();
  await pgRest.close();
  await sql.end();
  process.exit(0);
});
