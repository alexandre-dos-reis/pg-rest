// pg-rest on Node.js: @hono/node-server (http -> Request/Response) + node-postgres.
import { serve } from "@hono/node-server";
import pg from "pg";
import { createPgRest } from "../../dist/index.js";
import { nodePostgresAdapter } from "../../dist/adapters/node-postgres.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.POOL ?? 10) });
const pgRest = await createPgRest({
  db: nodePostgresAdapter(pool as never),
  schemas: ["api"],
  anonymousRole: "anon",
  resolveContext: (req) => {
    const sub = req.headers.get("x-user");
    return sub ? { role: "authenticated", claims: { sub } } : undefined;
  },
});
const port = Number(process.env.PORT);
serve({ fetch: (req) => pgRest.handle(req), port });
console.log(`ready ${port}`);
