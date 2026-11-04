import { serve } from "@hono/node-server"; // only used to turn Node's http into Request/Response
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";
import { createPgRest } from "pg-rest";
import { nodePostgresAdapter } from "pg-rest/adapters/node-postgres";

const port = Number(process.env.PORT ?? 3000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres" });

// Better Auth: email + password, sessions in a cookie. Its tables ("user", "session"...) live in the
// `public` schema, which pg-rest does not expose (only `api` is).
const authOptions = {
  database: pool,
  baseURL: `http://localhost:${port}`,
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me-0123456789abcdef",
  emailAndPassword: { enabled: true },
};
await (await getMigrations(authOptions)).runMigrations(); // creates the auth tables if missing
// Link todos to the Better Auth user. It can only be created now that "user" exists (schema.sql runs first).
await pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'todos_owner_id_fkey' AND conrelid = 'api.todos'::regclass) THEN
      ALTER TABLE api.todos ADD CONSTRAINT todos_owner_id_fkey
        FOREIGN KEY (owner_id) REFERENCES public."user"(id) ON DELETE CASCADE;
    END IF;
  END $$`);
const auth = betterAuth(authOptions);

const pgRest = await createPgRest({
  db: nodePostgresAdapter(pool),
  schemas: ["api"],
  anonymousRole: "anon",
  // The session cookie -> who is calling. `sub` is what the RLS policies in schema.sql read.
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
