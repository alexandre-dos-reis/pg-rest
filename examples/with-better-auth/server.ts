import { serve } from "@hono/node-server"; // only used to turn Node's http into Request/Response
import { betterAuth } from "better-auth";
import pg from "pg";
import { createPgRest } from "pg-rest";
import { nodePostgresAdapter } from "pg-rest/adapters/node-postgres";

const port = Number(process.env.PORT ?? 3000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres" });

// Better Auth: email + password, sessions in a cookie. Its tables ("user", "session"...) are created by
// 1-better-auth.sql in the `public` schema, which pg-rest does not expose (only `api` is).
const authOptions = {
  database: pool,
  baseURL: `http://localhost:${port}`,
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me-0123456789abcdef",
  emailAndPassword: { enabled: true },
};
const auth = betterAuth(authOptions);

const pgRest = await createPgRest({
  db: nodePostgresAdapter(pool),
  schemas: ["api"],
  anonymousRole: "anon",
  // The session cookie -> who is calling. `sub` is what the RLS policies in 2-api.sql read.
  resolveContext: async (req) => {
    const session = await auth.api.getSession({ headers: req.headers });
    return session ? { role: "authenticated", claims: { sub: session.user.id, email: session.user.email } } : undefined;
  },
});

const server = serve({
  port,
  fetch: (req) => (new URL(req.url).pathname.startsWith("/api/auth") ? auth.handler(req) : pgRest.handle(req)),
});
console.log(`pg-rest + Better Auth listening on http://localhost:${port}`);

process.on("SIGINT", async () => {
  server.close();
  await pgRest.close();
  await pool.end();
  process.exit(0);
});
