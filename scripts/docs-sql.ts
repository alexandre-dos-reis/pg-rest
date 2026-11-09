/**
 * Writes, under every TypeScript example of `docs/query.md` that calls an operation, the SQL the
 * library runs for it. Nothing here is written by hand: each call is evaluated against the fixture
 * database through an adapter that records the statements, and the last one -- the statement
 * itself, after the transaction setup -- is what lands in the page, without the JSON envelope the
 * engine wraps every statement in (see `withoutEnvelope`).
 *
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres bun scripts/docs-sql.ts          # rewrite
 *   TEST_DATABASE_URL=...                                         bun scripts/docs-sql.ts --check  # fail if stale
 *
 * The generated part of a page sits between `<!-- sql:start -->` and `<!-- sql:end -->`, so a rerun
 * replaces it. A call whose argument is not self-contained (it reads `ctx`, a variable, an earlier
 * result) or that is meant to be refused (`@ts-expect-error`) gets no SQL: it is listed on stderr.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { DbAdapter, DbSession } from "../packages/core/src/adapter";
import { createTestDb } from "../tests/support/db";
import { createPgRest } from "../tests/support/pgrest";

const FILE = new URL("../docs/query.md", import.meta.url).pathname;
const START = "<!-- sql:start -->";
const END = "<!-- sql:end -->";

// ---------------------------------------------------------------------------
// reading the page
// ---------------------------------------------------------------------------

/** The index after the string or template literal that starts at `i`. */
const skipString = (s: string, i: number): number => {
  const quote = s[i]!;
  i++;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote === "`" && c === "$" && s[i + 1] === "{") {
      i = skipBracket(s, i + 1);
      continue;
    }
    i++;
  }
  return i;
};

/** The index after the bracket group that starts at `i`, strings and comments skipped. */
const skipBracket = (s: string, i: number): number => {
  let depth = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(s, i);
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      i = s.indexOf("*/", i) + 2;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
};

type Operation = "select" | "insert" | "upsert" | "update" | "delete" | "rpc";

interface Call {
  readonly operation: Operation;
  readonly object: string;
}

const CALL = /\b(?:pgRest|tx|db|pgQuery|loose|bound)\.(select|insert|upsert|update|delete|rpc)(?:<(?:[^<>()]|<[^<>]*>)*>)?\(\s*(?=\{)/g;

/** The calls of one block, in order, and the ones that were left out with the reason. */
const callsOf = (code: string): { calls: Call[]; skipped: string[] } => {
  const calls: Call[] = [];
  const skipped: string[] = [];
  for (const m of code.matchAll(CALL)) {
    const start = m.index! + m[0].length;
    const object = code.slice(start, skipBracket(code, start));
    const before = code.slice(0, m.index!).split("\n").reverse();
    const lineBefore = before.slice(1).find((l) => l.trim() !== "")?.trim() ?? "";
    if (lineBefore.startsWith("// @ts-expect-error")) {
      skipped.push(`refused on purpose: ${object.slice(0, 60).replace(/\s+/g, " ")}`);
      continue;
    }
    calls.push({ operation: m[1] as Operation, object });
  }
  return { calls, skipped };
};

// ---------------------------------------------------------------------------
// formatting the SQL
// ---------------------------------------------------------------------------

const CLAUSES = [
  "INSERT INTO",
  "DELETE FROM",
  "ON CONFLICT",
  "GROUP BY",
  "ORDER BY",
  "LEFT JOIN",
  "INNER JOIN",
  "CROSS JOIN",
  "UPDATE",
  "SELECT",
  "FROM",
  "WHERE",
  "LIMIT",
  "OFFSET",
  "RETURNING",
  "VALUES",
  "SET",
  "WITH",
  "UNION",
];
const OPENERS = /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|VALUES)\b/i;
const WIDTH = 96;

/** One statement over several lines: a clause per line, a block (`(SELECT ...)`) indented. */
const prettify = (sql: string): string => {
  let out = "";
  const stack: Array<"block" | "inline"> = [];
  const blocks = () => stack.filter((k) => k === "block").length;
  const inInline = () => stack[stack.length - 1] === "inline";
  const newline = (extra = 0) => {
    out = out.replace(/[ ]+$/, "");
    if (out === "" || out.endsWith("\n")) {
      out += "  ".repeat(blocks() + extra);
      return;
    }
    out += "\n" + "  ".repeat(blocks() + extra);
  };
  let clause = "";
  let i = 0;
  let lineStart = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const j = skipQuoted(sql, i);
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (c === "(") {
      const kind = OPENERS.test(sql.slice(i + 1)) ? "block" : "inline";
      out += "(";
      stack.push(kind);
      if (kind === "block") newline();
      i++;
      continue;
    }
    if (c === ")") {
      const kind = stack.pop();
      if (kind === "block") {
        newline();
        out = out.replace(/[ ]+$/, "") + "  ".repeat(blocks()) + ")";
      } else out += ")";
      i++;
      continue;
    }
    if (c === "," && !inInline()) {
      out += ",";
      i++;
      while (sql[i] === " ") i++;
      const line = out.length - (out.lastIndexOf("\n") + 1);
      if (clause === "WITH" || line > WIDTH) newline(clause === "WITH" ? 0 : 1);
      else out += " ";
      continue;
    }
    if (!inInline() && /[A-Za-z]/.test(c) && (i === 0 || !/[\w"$]/.test(sql[i - 1]!))) {
      const hit = CLAUSES.find((k) => sql.slice(i, i + k.length).toUpperCase() === k && !/[\w]/.test(sql[i + k.length] ?? " "));
      if (hit) {
        if (hit === "SET" && clause !== "UPDATE" && clause !== "SET" && !/DO UPDATE\s*$/i.test(out)) {
          out += hit;
        } else {
          if (!(hit === "SELECT" && /\(\s*$/.test(out))) newline();
          out += hit;
          clause = hit.split(" ")[0]!;
          if (hit === "WITH") clause = "WITH";
        }
        i += hit.length;
        lineStart = out.length;
        continue;
      }
    }
    out += c;
    i++;
  }
  void lineStart;
  return out.replace(/^\s+/, "").replace(/[ ]+\n/g, "\n");
};

const skipQuoted = (s: string, i: number): number => {
  const q = s[i]!;
  i++;
  while (i < s.length) {
    if (s[i] === q) {
      if (s[i + 1] === q) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
};

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

interface Recorded {
  readonly text: string;
  readonly params: ReadonlyArray<string | null> | undefined;
}

const SETUP = /^(SELECT set_config\(|SET TRANSACTION|BEGIN|COMMIT|SAVEPOINT|RELEASE|ROLLBACK)/;

const recorder = (adapter: DbAdapter, log: Recorded[]): DbAdapter => {
  const wrap = (session: DbSession): DbSession => ({
    query: (text, params) => {
      log.push({ text, params });
      return session.query(text, params);
    },
  });
  return {
    ...wrap(adapter),
    transaction: (fn) => adapter.transaction((session) => fn(wrap(session))),
    ...(adapter.close ? { close: () => adapter.close!() } : {}),
  };
};

/**
 * The statement without its envelope. Every statement ends with the same `SELECT count(*) ...
 * FROM pgrst_body`, which turns the rows into JSON and carries the counts back; what a reader wants
 * is `pgrst_body`, the query itself, so that is what is shown -- with what a write needs in front
 * of it (`pgrst_source`, and `pgrst_ins` for an upsert). The total a `count` asks for is the one
 * thing the envelope computes that is not constant, so it is kept as a comment.
 */
const withoutEnvelope = (text: string): { sql: string; total: string | undefined } => {
  const tail = /\sSELECT count\(\*\)::text AS page_total, (.*) FROM pgrst_body AS _t$/;
  const found = tail.exec(text);
  if (!found) return { sql: text, total: undefined };
  const head = text.slice(0, found.index);
  const at = head.lastIndexOf("pgrst_body AS (");
  if (at < 0 || !head.endsWith(")")) return { sql: text, total: undefined };
  const body = head.slice(at + "pgrst_body AS (".length, -1);
  const before = head.slice(0, at).replace(/,\s*$/, "").trim();
  const total = /AS body, (.*?)::text AS total_result_set/.exec(found[1]!)?.[1];
  return {
    sql: before === "WITH" ? body : `${before} ${body}`,
    total: total && total !== "NULL" ? total.replace(/^\((.*)\)$/, "$1") : undefined,
  };
};

const literal = (p: string | null): string => {
  if (p === null) return "NULL";
  const shown = p.length > 80 ? `${p.slice(0, 77)}...` : p;
  return `'${shown.replace(/'/g, "''")}'`;
};

const labelOf = (call: Call, object: Record<string, unknown>): string => {
  const schema = typeof object["schema"] === "string" ? object["schema"] : "api";
  const table = typeof object["table"] === "string" ? `${schema}.${object["table"]}` : "";
  switch (call.operation) {
    case "select":
      return `select from ${table}`;
    case "insert":
      return `insert into ${table}`;
    case "upsert":
      return `upsert into ${table}`;
    case "update":
      return `update ${table}`;
    case "delete":
      return `delete from ${table}`;
    case "rpc":
      return `call ${schema}.${String(object["rpc"])}`;
  }
};

const main = async () => {
  const check = process.argv.includes("--check");
  const original = readFileSync(FILE, "utf8");
  const lines = original.split("\n");

  const db = await createTestDb();
  const log: Recorded[] = [];
  const pgRest = (await createPgRest({ db: recorder(db.adapter, log), schemas: ["api", "v2"] })) as unknown as Record<
    Operation,
    (input: unknown) => Promise<unknown>
  >;
  const transpiler = new Bun.Transpiler({ loader: "ts" });

  const out: string[] = [];
  const skippedAll: string[] = [];
  let produced = 0;

  for (let i = 0; i < lines.length; i++) {
    // a region of a previous run: dropped, and written again below its block
    if (lines[i] === START) {
      while (i < lines.length && lines[i] !== END) i++;
      if (out[out.length - 1] === "") out.pop();
      continue;
    }
    out.push(lines[i]!);
    if (lines[i] !== "```ts") continue;

    const body: string[] = [];
    i++;
    while (i < lines.length && lines[i] !== "```") body.push(lines[i++]!);
    out.push(...body, "```");

    const { calls, skipped } = callsOf(body.join("\n"));
    skippedAll.push(...skipped);
    const statements: string[] = [];
    for (const call of calls) {
      let object: Record<string, unknown>;
      try {
        const js = transpiler.transformSync(`const __o = (${call.object});`);
        object = new Function(`${js}; return __o;`)() as Record<string, unknown>;
      } catch (e) {
        skippedAll.push(`not self-contained (${(e as Error).message}): ${call.object.slice(0, 60).replace(/\s+/g, " ")}`);
        continue;
      }
      log.length = 0;
      await pgRest[call.operation](object);
      const statement = [...log].reverse().find((r) => !SETUP.test(r.text));
      if (!statement) {
        skippedAll.push(`no statement: ${call.object.slice(0, 60).replace(/\s+/g, " ")}`);
        continue;
      }
      const params = (statement.params ?? []).map((p, n) => `-- $${n + 1} = ${literal(p)}`);
      const { sql, total } = withoutEnvelope(statement.text);
      const counted = total ? [`-- the total that \`count\` asks for: ${total}`] : [];
      statements.push([`-- ${labelOf(call, object)}`, `${prettify(sql)};`, ...counted, ...params].join("\n"));
      produced++;
    }
    if (statements.length === 0) continue;

    // blank line after the fence of the block, as the page had it
    const hadBlank = lines[i + 1] === "";
    out.push(
      "",
      START,
      "<details>",
      "<summary>The SQL it runs</summary>",
      "",
      "```sql",
      statements.join("\n\n"),
      "```",
      "",
      "</details>",
      END,
    );
    if (hadBlank) {
      /* the original blank line is pushed by the loop */
    }
  }

  await pgRest["select"]({ table: "clients" }).catch(() => undefined);
  await (pgRest as unknown as { close(): Promise<void> }).close();
  await db.drop();

  const next = out.join("\n");
  if (skippedAll.length) console.error(`left without SQL (${skippedAll.length}):\n  ${skippedAll.join("\n  ")}`);
  console.error(`${produced} statements`);
  if (check) {
    if (next !== original) {
      console.error("docs/query.md is stale: run `bun scripts/docs-sql.ts`");
      process.exit(1);
    }
    return;
  }
  if (next !== original) writeFileSync(FILE, next);
};

await main();
