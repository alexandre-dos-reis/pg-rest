// bun run example/server.ts
// Needs DATABASE_URL (see example/README.md). Auth here is a deliberately naive
// "X-User" header: replace resolveContext with your real session/API-key lookup.
import { createPgRest } from "../src/index";

const api = await createPgRest({
  db: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
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
  process.exit(0);
});
