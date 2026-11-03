// bun run example/server.ts
// Needs DATABASE_URL (see example/README.md). Auth here is a deliberately naive
// "X-User" header: replace resolveContext with your real session/API-key lookup.
import { SQL } from "bun";
import { createPgRest } from "../src/index";
import { bunSqlAdapter } from "./adapters/bun-sql";

const sql = new SQL(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres");

const api = await createPgRest({
  db: bunSqlAdapter(sql), // pg-rest has no driver of its own: you pass one (see example/adapters)
  schemas: ["api"],
  anonymousRole: "anon",
  resolveContext: (req) => {
    const user = req.headers.get("x-user");
    return user ? { role: "authenticated", claims: { sub: user } } : undefined; // undefined -> anon
  },
});

const server = Bun.serve({ port: 3000, fetch: (req) => api.handle(req) });
console.log(`pg-rest example listening on ${server.url}`);

process.on("SIGINT", async () => {
  await api.close();
  await sql.close();
  process.exit(0);
});
