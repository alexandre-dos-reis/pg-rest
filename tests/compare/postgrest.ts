import { createHmac } from "node:crypto";

/** Path to a `postgrest` v16 binary. Comparison tests are skipped without it. */
export const POSTGREST_BIN = process.env["POSTGREST_BIN"];
export const JWT_SECRET = "pg-rest-comparison-secret-0123456789abcdef";

const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

/** HS256 token for the real PostgREST, carrying the same role/claims pg-rest receives via its context. */
export const signJwt = (claims: Record<string, unknown>): string => {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(claims);
  const sig = createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
};

export interface RunningPostgrest {
  readonly url: string;
  readonly pid: number;
  stop(): Promise<void>;
}

export const startPostgrest = async (
  dbUrl: string,
  port: number,
  schemas: string[],
  pool = 2,
): Promise<RunningPostgrest> => {
  if (!POSTGREST_BIN) throw new Error("POSTGREST_BIN is not set");
  const proc = Bun.spawn([POSTGREST_BIN], {
    env: {
      PATH: process.env["PATH"] ?? "",
      PGRST_DB_URI: dbUrl,
      PGRST_DB_SCHEMAS: schemas.join(","),
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_DB_TX_END: "commit-allow-override",
      PGRST_DB_POOL: String(pool),
      PGRST_DB_AGGREGATES_ENABLED: "true", // off by default in v16; pg-rest always allows aggregates
      PGRST_JWT_SECRET: JWT_SECRET,
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_SERVER_PORT: String(port),
      PGRST_LOG_LEVEL: "error",
      PGRST_OPENAPI_SERVER_PROXY_URI: "http://localhost",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const r = await fetch(`${url}/clients?limit=1`);
      if (r.status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`PostgREST did not start: ${await new Response(proc.stderr).text()}`);
    }
    await Bun.sleep(150);
  }
  return {
    url,
    pid: proc.pid,
    async stop() {
      proc.kill();
      await proc.exited;
    },
  };
};
