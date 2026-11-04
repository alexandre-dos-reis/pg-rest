import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasDb } from "../support/db";
import { makeApi, type TestApi } from "../support/api";
import { cases, type Case } from "./cases";
import { POSTGREST_BIN, signJwt, startPostgrest, type RunningPostgrest } from "./postgrest";

/**
 * Differential test: every case is sent to the real PostgREST 16 and to pg-rest, both on the same
 * database, and the responses are compared. Run with:
 *   POSTGREST_BIN=/path/to/postgrest TEST_DATABASE_URL=postgres://... bun test tests/compare
 */
const enabled = hasDb && Boolean(POSTGREST_BIN);

interface Seen {
  status: number;
  contentType: string | null;
  contentRange: string | null;
  location: string | null;
  preferenceApplied: string | null;
  allow: string | null;
  body: unknown;
}

const identities = {
  anon: { token: undefined, ctx: undefined },
  alice: {
    token: signJwt({ role: "authenticated", sub: "alice" }),
    ctx: { role: "authenticated", claims: { sub: "alice" } },
  },
  bob: {
    token: signJwt({ role: "authenticated", sub: "bob" }),
    ctx: { role: "authenticated", claims: { sub: "bob" } },
  },
} as const;

/** Drop values that legitimately differ between two runs (now()-based timestamps). */
const scrub = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => k !== "created_at")
        .map(([k, x]) => [k, scrub(x)]),
    );
  }
  if (typeof v === "string") return v.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?[+-]\d\d/g, "<timestamp>");
  return v;
};
const tokens = (v: string | null) =>
  v === null
    ? null
    : v
        .split(",")
        .map((t) => t.trim())
        .sort()
        .join(", ");

const normalize = async (res: Response, c: Case): Promise<Seen> => {
  const text = await res.text();
  const ct = res.headers.get("content-type");
  let body: unknown = text;
  if (c.ignoreBody) body = "(ignored)";
  else if (ct?.includes("json")) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    status: res.status,
    contentType: ct
      ? ct
          .replace(/;\s*charset=utf-8/i, "")
          .replace(/\s+/g, "")
          .toLowerCase()
      : null,
    contentRange: res.headers.get("content-range"),
    location: res.headers.get("location"),
    preferenceApplied: tokens(res.headers.get("preference-applied")),
    allow: res.headers.get("allow"),
    body: scrub(body),
  };
};

describe.skipIf(!enabled)("pg-rest vs PostgREST 16", () => {
  let ours: TestApi;
  let theirs: RunningPostgrest;

  beforeAll(async () => {
    ours = await makeApi({ allowTxOverride: true });
    theirs = await startPostgrest(ours.db.url, 54340 + Math.floor(Math.random() * 500), ["api", "v2"]);
  }, 60_000);
  afterAll(async () => {
    await theirs?.stop();
    await ours?.close();
  });

  const send = async (base: string | null, c: Case): Promise<Response> => {
    const who = identities[c.as ?? "anon"];
    const headers: Record<string, string> = { ...c.headers };
    let body: string | undefined;
    if (c.body !== undefined) {
      if (typeof c.body === "string") body = c.body;
      else {
        body = JSON.stringify(c.body);
        headers["Content-Type"] ??= "application/json";
      }
    }
    const method = c.method ?? "GET";
    if (base === null) {
      return ours.api.handle(
        new Request(`http://localhost${c.path}`, { method, headers, ...(body !== undefined ? { body } : {}) }),
        who.ctx as never,
      );
    }
    if (who.token) headers["Authorization"] = `Bearer ${who.token}`;
    return fetch(`${base}${c.path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  };

  /** Rolled-back inserts still consume sequence values; restore them so both engines see the same ids. */
  const snapshot = async () =>
    ours.db.adapter.query("SELECT schemaname || '.' || sequencename AS name, last_value::text AS v FROM pg_sequences");
  const restore = async (snap: Awaited<ReturnType<typeof snapshot>>) => {
    for (const r of snap) {
      const name = String(r["name"]).replace(/'/g, "''");
      await ours.db.adapter.query(
        r["v"] === null ? `SELECT setval('${name}', 1, false)` : `SELECT setval('${name}', ${Number(r["v"])}, true)`,
      );
    }
  };

  for (const c of cases) {
    test(`${c.known ? "[known difference] " : ""}${c.name}${c.as && c.as !== "anon" ? ` (as ${c.as})` : ""}`, async () => {
      const snap = await snapshot();
      const a = await normalize(await send(theirs.url, c), c);
      await restore(snap);
      const b = await normalize(await send(null, c), c);
      await restore(snap);
      if (c.known) expect(b).not.toEqual(a);
      else expect(b).toEqual(a);
    });
  }
});
