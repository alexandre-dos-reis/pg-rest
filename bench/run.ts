/**
 * Load test: PostgREST 16 vs pg-rest (Bun and Node) on the same PostgreSQL database, with the same
 * data, connection-pool size and requests. Build first (`bun run build`), then:
 *
 *   POSTGREST_BIN=/path/to/postgrest BENCH_ADMIN_URL=postgres://user@host:5432/postgres bun bench/run.ts
 *
 * Knobs (env): DURATION=8 WARMUP=2 CONNECTIONS=32 POOL=10 CLIENTS=20000 ORDERS=100000 PRODUCTS=1000
 *              TARGETS=postgrest,pg-rest-bun,pg-rest-bun-compiled,pg-rest-bun-bytecode,pg-rest-bun-aot,pg-rest-bun-aot-src,pg-rest-node,baseline
 *              ONLY=pk-lookup,list-50  KEEP=1  BASELINE_DIR=/path/to/older/checkout  AOT_BUN=/path/to/bun-with-`compile`
 */
import { SQL } from "bun";
import { cpus, totalmem } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { signJwt, startPostgrest } from "../packages/rest/tests/compare/postgrest";
import { scenarios, type Scenario } from "./scenarios";

const env = (k: string, d: string) => process.env[k] ?? d;
const num = (k: string, d: number) => Number(env(k, String(d)));

const ADMIN = process.env["BENCH_ADMIN_URL"] ?? process.env["TEST_DATABASE_URL"];
if (!ADMIN) throw new Error("set BENCH_ADMIN_URL (a superuser URL of a throwaway PostgreSQL server)");
if (!process.env["POSTGREST_BIN"]) throw new Error("set POSTGREST_BIN (path to a postgrest v16 binary)");

const cfg = {
  duration: num("DURATION", 8),
  warmup: num("WARMUP", 2),
  connections: num("CONNECTIONS", 32),
  pool: num("POOL", 10),
  clients: num("CLIENTS", 20000),
  orders: num("ORDERS", 100000),
  products: num("PRODUCTS", 1000),
};
const wanted = env("TARGETS", `postgrest,pg-rest-bun,pg-rest-bun-compiled,pg-rest-bun-bytecode,pg-rest-bun-aot,pg-rest-bun-aot-src,pg-rest-node${process.env["BASELINE_DIR"] ? ",baseline" : ""}`).split(",");
const only = process.env["ONLY"]?.split(",");
const root = new URL("..", import.meta.url).pathname;
const basePort = 3300 + Math.floor(Math.random() * 500);

// ── database ───────────────────────────────────────────────
const dbName = `pgrest_bench_${process.pid}_${Date.now()}`;
const admin = new SQL(ADMIN);
await admin.unsafe(`CREATE DATABASE ${dbName}`);
const dbUrl = new URL(ADMIN);
dbUrl.pathname = `/${dbName}`;
const sql = new SQL(dbUrl.toString());
console.log(`loading data (${cfg.clients} clients, ${cfg.orders} orders, ${cfg.products} products)...`);
await sql.unsafe(readFileSync(`${root}tests/support/fixture.sql`, "utf8"));
const data = readFileSync(`${root}bench/data.sql`, "utf8")
  .replace(/:clients\b/g, String(cfg.clients))
  .replace(/:orders\b/g, String(cfg.orders))
  .replace(/:products\b/g, String(cfg.products));
await sql.unsafe(data);
await sql.unsafe("INSERT INTO api.notes (owner, body) SELECT 'bench', 'note ' || g FROM generate_series(1, 50) g");

// ── targets ────────────────────────────────────────────────
interface Target {
  id: string;
  label: string;
  url: string;
  pid: number;
  stop(): Promise<void>;
  auth(): Record<string, string>;
}
const jwt = signJwt({ role: "authenticated", sub: "bench" });
const targets: Target[] = [];

const waitReady = async (url: string) => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/clients?limit=1`)).status === 200) return;
    } catch {}
    await Bun.sleep(150);
  }
  throw new Error(`${url} did not become ready`);
};
const spawnServer = async (id: string, label: string, cmd: string[], port: number): Promise<Target> => {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    env: { PATH: process.env["PATH"] ?? "", DATABASE_URL: dbUrl.toString(), PORT: String(port), POOL: String(cfg.pool) },
    stdout: "ignore",
    stderr: "inherit",
  });
  const url = `http://127.0.0.1:${port}`;
  await waitReady(url);
  return { id, label, url, pid: proc.pid, async stop() { proc.kill(); await proc.exited; }, auth: () => ({ "X-User": "bench" }) };
};

let port = basePort;
if (wanted.includes("postgrest")) {
  const pgrst = await startPostgrest(dbUrl.toString(), port++, ["api"], cfg.pool);
  targets.push({ id: "postgrest", label: "PostgREST 16", url: pgrst.url, pid: pgrst.pid, stop: pgrst.stop, auth: () => ({ Authorization: `Bearer ${jwt}` }) });
}
if (wanted.includes("pg-rest-bun")) targets.push(await spawnServer("pg-rest-bun", "pg-rest (Bun + Bun.sql)", ["bun", "bench/servers/bun.ts"], port++));
// Standalone executables of the Bun server, built the three ways Bun offers:
//   `bun build --compile`            bundled JS + JIT (stable)
//   `... --bytecode`                 same, plus pre-compiled JavaScriptCore bytecode
//   `bun compile` (= `--compile --aot`)  machine code, no JIT (experimental; needs a recent Bun, see AOT_BUN)
const bunBin = process.execPath;
const exes: [string, string, string, string[]][] = [
  ["pg-rest-bun-compiled", "pg-rest (bun build --compile)", bunBin, ["build", "--compile"]],
  ["pg-rest-bun-bytecode", "pg-rest (bun build --compile --bytecode)", bunBin, ["build", "--compile", "--bytecode", "--format=esm"]],
  ["pg-rest-bun-aot", "pg-rest (bun compile, AOT)", process.env["AOT_BUN"] ?? bunBin, ["compile"]],
  ["pg-rest-bun-aot-src", "pg-rest (bun compile, AOT, from src)", process.env["AOT_BUN"] ?? bunBin, ["compile"]],
];
for (const [id, label, bin, args] of exes) {
  if (!wanted.includes(id)) continue;
  mkdirSync(`${root}bench/results`, { recursive: true });
  const exe = `${root}bench/results/${id}`;
  const build = Bun.spawnSync([bin, ...args, id.endsWith("-src") ? "bench/servers/bun-src.ts" : "bench/servers/bun.ts", "--outfile", exe], { cwd: root, stdout: "ignore", stderr: "inherit" });
  if (build.exitCode !== 0) throw new Error(`${bin} ${args.join(" ")} failed`);
  targets.push(await spawnServer(id, label, [exe], port++));
}
// An older checkout (built, with bench/servers/bun.ts) to compare against, e.g. the Effect-based version.
const baselineDir = process.env["BASELINE_DIR"];
if (baselineDir && wanted.includes("baseline")) {
  targets.push(await spawnServer("baseline", "pg-rest baseline (Bun)", ["bun", `${baselineDir}/bench/servers/bun.ts`], port++));
}
if (wanted.includes("pg-rest-node")) targets.push(await spawnServer("pg-rest-node", "pg-rest (Node + pg)", ["node", "bench/servers/node.ts"], port++));

// ── helpers ────────────────────────────────────────────────
const requestFor = (t: Target, s: Scenario) => ({
  method: s.method ?? "GET",
  headers: { ...(s.body !== undefined ? { "Content-Type": "application/json" } : {}), ...s.headers, ...(s.auth ? t.auth() : {}) } as Record<string, string>,
  body: s.body !== undefined ? JSON.stringify(s.body) : undefined,
});

const hwm = async (pid: number): Promise<number> => {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(await Bun.file(`/proc/${pid}/status`).text());
    return m ? Number(m[1]) / 1024 : NaN;
  } catch {
    return NaN;
  }
};

interface Stat { rps: number; p50: number; p99: number; ok: number; bad: number; errors: number }
const autocannon = async (t: Target, s: Scenario, seconds: number): Promise<Stat> => {
  const r = requestFor(t, s);
  const args = [`${root}node_modules/autocannon/autocannon.js`, "-j", "-c", String(cfg.connections), "-d", String(seconds), "-m", r.method];
  for (const [k, v] of Object.entries(r.headers)) args.push("-H", `${k}: ${v}`);
  if (r.body !== undefined) args.push("-b", r.body);
  args.push(`${t.url}${s.path}`);
  const proc = Bun.spawn(["node", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = JSON.parse(await new Response(proc.stdout).text());
  await proc.exited;
  return { rps: out.requests.average, p50: out.latency.p50, p99: out.latency.p99, ok: out["2xx"], bad: out.non2xx, errors: out.errors + out.timeouts };
};

// ── 1. same answers? (a benchmark of different work is meaningless) ──
console.log("\nchecking that every target returns the same result...");
const mismatches = new Set<string>();
for (const s of scenarios) {
  if (only && !only.includes(s.name)) continue;
  if (s.skipEquality || targets.length < 2) continue;
  const answers = await Promise.all(targets.map(async (t) => {
    const r = requestFor(t, s);
    const res = await fetch(`${t.url}${s.path}`, { method: r.method, headers: r.headers, body: r.body });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  }));
  const [first, ...rest] = answers;
  if (rest.some((a) => a.status !== first!.status || !Bun.deepEquals(a.body, first!.body))) {
    mismatches.add(s.name);
    console.log(`  ⚠ ${s.name}: ${answers.map((a, i) => `${targets[i]!.id}=${a.status}`).join(" ")}`);
    if (process.env["VERBOSE"]) for (const [i, a] of answers.entries()) console.log(`      ${targets[i]!.id}: ${JSON.stringify(a.body).slice(0, 260)}`);
  }
}
if (mismatches.size === 0) console.log("  all identical");

// ── 2. load ────────────────────────────────────────────────
const results = new Map<string, Map<string, Stat>>();
let n = 0;
for (const s of scenarios) {
  if (only && !only.includes(s.name)) continue;
  results.set(s.name, new Map());
  const order = [...targets.slice(n % targets.length), ...targets.slice(0, n % targets.length)]; // rotate to avoid order bias
  n++;
  for (const t of order) {
    if (cfg.warmup > 0) await autocannon(t, s, cfg.warmup);
    const stat = await autocannon(t, s, cfg.duration);
    results.get(s.name)!.set(t.id, stat);
    console.log(`${s.name.padEnd(18)} ${t.label.padEnd(26)} ${stat.rps.toFixed(0).padStart(7)} req/s  p50 ${stat.p50}ms  p99 ${stat.p99}ms${stat.bad || stat.errors ? `  ⚠ non2xx=${stat.bad} errors=${stat.errors}` : ""}`);
  }
}
const memory = new Map<string, number>();
for (const t of targets) memory.set(t.id, await hwm(t.pid));

// ── report ─────────────────────────────────────────────────
const nodeVersion = (await new Response(Bun.spawn(["node", "--version"], { stdout: "pipe" }).stdout).text()).trim();
const base = targets.find((t) => t.id === "postgrest");
const fmt = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));
let md = `## Throughput (requests/second, higher is better)\n\n| scenario | what |`;
for (const t of targets) md += ` ${t.label} |` + (base && t !== base ? " vs PostgREST |" : "");
md += `\n| --- | --- |` + targets.map((t) => " ---: |" + (base && t !== base ? " ---: |" : "")).join("") + "\n";
for (const [name, byTarget] of results) {
  const s = scenarios.find((x) => x.name === name)!;
  md += `| ${name}${mismatches.has(name) ? " ⚠" : ""} | ${s.what} |`;
  for (const t of targets) {
    const st = byTarget.get(t.id)!;
    md += ` ${fmt(st.rps)}${st.bad || st.errors ? " ⚠" : ""} |`;
    if (base && t !== base) md += ` ${(st.rps / byTarget.get(base.id)!.rps).toFixed(2)}× |`;
  }
  md += "\n";
}
md += `\n## Latency (ms, p50 / p99, lower is better)\n\n| scenario |` + targets.map((t) => ` ${t.label} |`).join("") + "\n| --- |" + targets.map(() => " ---: |").join("") + "\n";
for (const [name, byTarget] of results) {
  md += `| ${name} |` + targets.map((t) => { const st = byTarget.get(t.id)!; return ` ${st.p50} / ${st.p99} |`; }).join("") + "\n";
}
md += `\n## Peak memory (RSS, MB)\n\n` + targets.map((t) => `- ${t.label}: ${fmt(memory.get(t.id)!)}`).join("\n") + "\n";
md += `\n## Setup\n\n- ${cpus().length} × ${cpus()[0]?.model.trim()}, ${(totalmem() / 2 ** 30).toFixed(1)} GiB RAM (load generator, servers and PostgreSQL share this machine)\n- ${cfg.connections} concurrent connections, ${cfg.duration}s per run after ${cfg.warmup}s warm-up, pool of ${cfg.pool} database connections per server\n- data: ${cfg.clients} clients, ${cfg.orders} orders, ${cfg.products} products\n- Bun ${Bun.version}, Node ${nodeVersion}\n- ⚠ next to a scenario: the targets returned different results, or some responses were not 2xx\n`;

mkdirSync(`${root}bench/results`, { recursive: true });
writeFileSync(`${root}bench/results/latest.md`, md);
writeFileSync(`${root}bench/results/latest.json`, JSON.stringify({ cfg, results: Object.fromEntries([...results].map(([k, v]) => [k, Object.fromEntries(v)])), memory: Object.fromEntries(memory), mismatches: [...mismatches] }, null, 2));
console.log("\n" + md);

for (const t of targets) await t.stop();
await sql.close();
if (!process.env["KEEP"]) await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.close();
