import { serve } from "@hono/node-server"; // only used to turn Node's http into Request/Response
import pg from "pg";
import { createPgRest } from "@adrdp/pg-rest";
import { nodePostgresAdapter } from "@adrdp/pg-rest/adapters/node-postgres";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
});

const pgRest = await createPgRest({
  db: nodePostgresAdapter(pool),
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
console.log(`pg-rest (node-postgres) listening on http://localhost:${port}`);

process.on("SIGINT", async () => {
  server.close();
  await pgRest.close();
  await pool.end();
  process.exit(0);
});
