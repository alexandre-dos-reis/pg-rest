import { SQL } from "bun";
import { createRest } from "@tspg/rest";
import { bunSqlAdapter } from "@tspg/rest/adapters/bun";

const sql = new SQL(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres");

const pgRest = await createRest({
  db: bunSqlAdapter(sql),
  schemas: ["api"],
  anonymousRole: "anon",
  resolveContext: (req) => {
    // Replace this with your real auth: session cookie, API key, ... (there is no JWT).
    const user = req.headers.get("x-user");
    return user ? { role: "authenticated", claims: { sub: user } } : undefined; // undefined -> "anon"
  },
});

const server = Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: (req) => pgRest.handle(req) });
console.log(`pg-rest (Bun.sql) listening on ${server.url}`);

process.on("SIGINT", async () => {
  await pgRest.close();
  await sql.close();
  process.exit(0);
});
