import { serve } from "@hono/node-server"; // only used to turn Node's http into Request/Response
import { Hono } from "hono";
import { betterAuth } from "better-auth";
import pg from "pg";
import { createPgRest } from "pg-rest";
import { nodePostgresAdapter } from "pg-rest/adapters/node-postgres";

const port = Number(process.env.PORT ?? 3000);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
});

// Better Auth: email + password, sessions in a cookie. Its tables ("user", "session"...) are created by
// 1-better-auth.sql in the `public` schema, which pg-rest does not expose (only `api` is).
const auth = betterAuth({
  database: pool,
  baseURL: `http://localhost:${port}`,
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me-0123456789abcdef",
  emailAndPassword: { enabled: true },
});

const pgRest = await createPgRest({
  basePath: "/api/rest",
  db: nodePostgresAdapter(pool),
  schemas: ["api"],
  anonymousRole: "anon",
  // The session cookie -> who is calling. `sub` is what the RLS policies in 2-api.sql read.
  resolveContext: async (req) => {
    const session = await auth.api.getSession({ headers: req.headers });
    return session ? { role: "authenticated", claims: { sub: session.user.id, email: session.user.email } } : undefined;
  },
});

const app = new Hono();

app.all("/api/auth/*", (c) => auth.handler(c.req.raw));
app.all("/api/rest/*", (c) => pgRest.handle(c.req.raw));

const server = serve(app);

console.log(`Better Auth listening on http://localhost:${port}/api/auth`);
console.log(`pg-rest listening on http://localhost:${port}/api/rest`);

process.on("SIGINT", async () => {
  server.close();
  await pgRest.close();
  await pool.end();
  process.exit(0);
});
