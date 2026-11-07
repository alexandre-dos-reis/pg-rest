// pg-rest on Bun: Bun.serve + Bun.sql. Uses the *built* package, as a consumer would.
import { SQL } from "bun";
import { createRest } from "../../packages/rest/dist/index.js";
import { bunSqlAdapter } from "../../packages/rest/dist/adapters/bun.js";

const sql = new SQL({ url: process.env.DATABASE_URL!, max: Number(process.env.POOL ?? 10) });
const pgRest = await createRest({
  db: bunSqlAdapter(sql),
  schemas: ["api"],
  anonymousRole: "anon",
  // cheapest possible "auth": a header. (PostgREST has to verify a JWT per request.)
  resolveContext: (req) => {
    const sub = req.headers.get("x-user");
    return sub ? { role: "authenticated", claims: { sub } } : undefined;
  },
});
const server = Bun.serve({ port: Number(process.env.PORT), fetch: (req) => pgRest.handle(req) });
console.log(`ready ${server.port}`);
