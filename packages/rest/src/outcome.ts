import { EngineError } from "@tsql/core/errors";
import { type Env, type Plan, type Result, shownBody } from "@tsql/core/core";
import { PgRestError } from "./errors";
import type { Prefer } from "./request";

/**
 * What a call comes to, before it is dressed as a `Response`: the status, the headers PostgREST's logic
 * decides (`Content-Range`, `Location`, `Preference-Applied`, whatever a function put in `response.headers`)
 * and the body. `toResponse` (`http.ts`) adds what is only transport (`Content-Type`, `Vary`).
 */
export interface Outcome {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
}

/** The settings a function answers with: `READ[0]` is its headers, `READ[1]` its status. */
export const RESPONSE_SETTINGS = ["response.headers", "response.status"] as const;

/** Parsed `response.headers` setting: `[{"X-A": "b"}, ...]`. */
const parseResponseHeaders = (raw: string | null | undefined): Record<string, string> => {
  if (raw == null || raw === "") return {};
  const bad = () =>
    new PgRestError(
      500,
      "PGRST111",
      "response.headers guc must be a JSON array composed of objects with a single key and a string value",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw bad();
  }
  if (!Array.isArray(parsed)) throw bad();
  const out: Record<string, string> = {};
  for (const h of parsed) {
    if (!h || typeof h !== "object" || Array.isArray(h)) throw bad();
    const keys = Object.keys(h);
    if (keys.length !== 1) throw bad();
    const v = (h as Record<string, unknown>)[keys[0]!];
    if (typeof v !== "string") throw bad();
    out[keys[0]!] = v;
  }
  return out;
};

const parseStatus = (raw: string | null | undefined): number | undefined => {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 100 || n > 599) {
    throw new PgRestError(500, "PGRST112", "response.status guc must be a valid status code");
  }
  return n;
};

/** `Preference-Applied`: the preferences this server took into account. */
export const appliedHeader = (p: Prefer, honoredTx: boolean): string | undefined => {
  const parts: string[] = [];
  if (honoredTx && p.tx) parts.push(`tx=${p.tx}`);
  if (p.return) parts.push(`return=${p.return}`);
  if (p.count) parts.push(`count=${p.count}`);
  if (p.resolution) parts.push(`resolution=${p.resolution}`);
  if (p.missing) parts.push(`missing=${p.missing}`);
  if (p.handling) parts.push(`handling=${p.handling}`);
  if (p.timezone) parts.push(`timezone=${p.timezone}`);
  if (p.maxAffected !== undefined && p.handling === "strict") parts.push(`max-affected=${p.maxAffected}`);
  return parts.length ? parts.join(", ") : undefined;
};

/** What the engine ran, as HTTP says it: status, `Content-Range`, `Location`, `Preference-Applied`, the body. */
export const buildOutcome = (_env: Env, prefer: Prefer, plan: Plan, r: Result, honoredTx: boolean): Outcome => {
  const headers: Record<string, string> = {};
  const applied = appliedHeader(prefer, honoredTx);
  if (applied) headers["Preference-Applied"] = applied;

  const total = r.total;
  const totalStr = total === undefined ? "*" : String(total);

  let status = 200;
  let text = shownBody(plan, r.body);

  if (
    plan.kind === "read" ||
    (plan.kind === "rpc" && plan.pagedRead !== undefined && (plan.shape === "array" || plan.shape === "object"))
  ) {
    const first = plan.offset;
    const last = plan.offset + r.rows - 1;
    headers["Content-Range"] = r.rows > 0 ? `${first}-${last}/${totalStr}` : `*/${totalStr}`;
    if (total !== undefined && r.rows > 0 && r.rows < total) status = 206;
    if (total !== undefined && r.rows === total && plan.offset > 0) status = 206;
  } else if (plan.kind === "rpc") {
    status = plan.shape === "none" ? 204 : 200;
    headers["Content-Range"] = r.rows > 0 ? `0-${r.rows - 1}/${totalStr}` : `*/${totalStr}`;
  } else {
    if (plan.kind === "update") {
      const n = r.rows;
      headers["Content-Range"] =
        n > 0
          ? `0-${n - 1}/${prefer.count === "exact" ? String(n) : "*"}`
          : `*/${prefer.count === "exact" ? "0" : "*"}`;
    } else if (plan.kind !== "put") {
      headers["Content-Range"] = `*/${prefer.count === "exact" ? String(r.rows) : "*"}`;
    }
    const ret = plan.returning ?? "minimal";
    if (plan.kind === "insert") {
      status = 201;
      if (ret === "pk") {
        const rows = JSON.parse(r.body || "[]") as Array<Record<string, unknown>>;
        const pk = plan.rel?.pk ?? [];
        if (rows.length === 1 && pk.length > 0) {
          const q = pk.map((c) => `${encodeURIComponent(c)}=eq.${encodeURIComponent(String(rows[0]![c]))}`).join("&");
          headers["Location"] = `/${encodeURIComponent(plan.rel!.name)}?${q}`;
        }
      }
    } else {
      status = ret === "representation" ? 200 : 204;
    }
  }

  Object.assign(headers, parseResponseHeaders(r.settings[0]));
  // an upsert that inserted nothing answers 200, unless a function chose
  const chosen = parseStatus(r.settings[1]) ?? (r.noneInserted ? 200 : undefined);
  if (chosen !== undefined) status = chosen;

  return { status, headers, text };
};

/** `range_not_satisfiable` as PostgREST answers it: with the preferences that were applied. */
export const withApplied = (e: unknown, prefer: Prefer, honoredTx: boolean): unknown => {
  if (!(e instanceof EngineError) || e.reason !== "range_not_satisfiable") return e;
  const applied = appliedHeader(prefer, honoredTx);
  return applied ? new EngineError(e.reason, e.message, e.details, e.hint, { ...e.data, applied }) : e;
};
