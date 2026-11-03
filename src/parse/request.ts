import { PgRestError } from "../errors";
import { parseError } from "./field";

export type Method = "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE" | "OPTIONS";

const METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]);

export const parseMethod = (m: string): Method => {
  const up = m.toUpperCase();
  if (!METHODS.has(up)) {
    throw new PgRestError(405, "PGRST117", `Unsupported HTTP method: ${m}`);
  }
  return up as Method;
};

export type Target =
  | { readonly type: "root" }
  | { readonly type: "table"; readonly name: string }
  | { readonly type: "rpc"; readonly name: string };

/**
 * Route a request path. `basePath` is stripped first, so the library can be
 * mounted anywhere (`/api/rest`, ...).
 */
export const parseTarget = (pathname: string, basePath = ""): Target => {
  let path = pathname;
  if (basePath && basePath !== "/") {
    const base = basePath.replace(/\/+$/, "");
    if (path === base) path = "/";
    else if (path.startsWith(`${base}/`)) path = path.slice(base.length);
    else throw new PgRestError(404, "PGRST125", `Invalid path specified in request URL`);
  }
  const segs = path.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      throw new PgRestError(400, "PGRST100", "Invalid URL encoding in path");
    }
  });
  if (segs.length === 0) return { type: "root" };
  if (segs[0] === "rpc") {
    if (segs.length !== 2) throw new PgRestError(404, "PGRST125", "Invalid path specified in request URL");
    return { type: "rpc", name: segs[1]! };
  }
  if (segs.length !== 1) throw new PgRestError(404, "PGRST125", "Invalid path specified in request URL");
  return { type: "table", name: segs[0]! };
};

// ---------------------------------------------------------------------------
// Prefer
// ---------------------------------------------------------------------------

export interface Preferences {
  readonly return?: "minimal" | "headers-only" | "representation";
  readonly count?: "exact" | "planned" | "estimated";
  readonly resolution?: "merge-duplicates" | "ignore-duplicates";
  readonly missing?: "default" | "null";
  readonly handling?: "strict" | "lenient";
  readonly tx?: "commit" | "rollback";
  readonly timezone?: string;
  readonly maxAffected?: number;
  /** Preferences that were present but not understood. */
  readonly invalid: ReadonlyArray<string>;
}

const PREFERENCE_VALUES: Record<string, ReadonlyArray<string>> = {
  return: ["minimal", "headers-only", "representation"],
  count: ["exact", "planned", "estimated"],
  resolution: ["merge-duplicates", "ignore-duplicates"],
  missing: ["default", "null"],
  handling: ["strict", "lenient"],
  tx: ["commit", "rollback"],
};

/** Parse one or more `Prefer` header values (comma separated tokens). */
export const parsePrefer = (header: string | null): Preferences => {
  const out: { -readonly [K in keyof Preferences]: Preferences[K] } = { invalid: [] };
  const invalid: string[] = [];
  if (!header) return out;
  for (const raw of header.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq < 0) {
      invalid.push(token);
      continue;
    }
    const key = token.slice(0, eq).trim().toLowerCase();
    const value = token.slice(eq + 1).trim();
    if (key === "timezone") {
      out.timezone = value;
    } else if (key === "max-affected") {
      if (/^\d+$/.test(value)) out.maxAffected = Number(value);
      else invalid.push(token);
    } else if (PREFERENCE_VALUES[key]?.includes(value)) {
      (out as Record<string, unknown>)[key] = value;
    } else {
      invalid.push(token);
    }
  }
  out.invalid = invalid;
  return out;
};

// ---------------------------------------------------------------------------
// Range / Accept / Content-Type
// ---------------------------------------------------------------------------

export interface RangeSpec {
  readonly offset: number;
  readonly limit?: number;
}

/** `Range: 5-14` (with `Range-Unit: items`, or none). */
export const parseRange = (range: string | null, unit: string | null): RangeSpec | undefined => {
  if (!range) return undefined;
  if (unit && unit.toLowerCase() !== "items") return undefined;
  const m = /^(?:items=)?(\d+)-(\d*)$/.exec(range.trim());
  if (!m) return undefined;
  const start = Number(m[1]);
  if (m[2] === "") return { offset: start };
  const end = Number(m[2]);
  if (end < start) {
    throw new PgRestError(416, "PGRST103", "Requested range not satisfiable", `The lower boundary must be lower than or equal to the upper boundary in the Range header.`, null);
  }
  return { offset: start, limit: end - start + 1 };
};

export type OutputFormat =
  | { readonly kind: "json"; readonly stripNulls: boolean }
  | { readonly kind: "object"; readonly stripNulls: boolean }
  | { readonly kind: "csv" }
  | { readonly kind: "openapi" };

const parseAcceptEntry = (entry: string) => {
  const [type = "", ...params] = entry.split(";").map((s) => s.trim());
  let q = 1;
  let stripNulls = false;
  for (const p of params) {
    const [k, v] = p.split("=").map((s) => s.trim().replace(/^"|"$/g, ""));
    if (k === "q") q = Number(v);
    else if (k === "nulls" && v === "stripped") stripNulls = true;
  }
  return { type: type.toLowerCase(), q: Number.isNaN(q) ? 1 : q, stripNulls };
};

/** Pick an output format from the `Accept` header. */
export const parseAccept = (accept: string | null, isRoot: boolean): OutputFormat => {
  const entries = (accept ?? "*/*")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map(parseAcceptEntry)
    .sort((a, b) => b.q - a.q);
  if (entries.length === 0) entries.push({ type: "*/*", q: 1, stripNulls: false });

  for (const { type, stripNulls } of entries) {
    switch (type) {
      case "*/*":
      case "application/*":
      case "application/json":
      case "application/openapi+json":
        if (isRoot) return { kind: "openapi" };
        if (type !== "application/openapi+json") return { kind: "json", stripNulls };
        break;
      case "application/vnd.pgrst.array+json":
        return { kind: "json", stripNulls };
      case "application/vnd.pgrst.object+json":
      case "application/vnd.pgrst.object":
        return { kind: "object", stripNulls };
      case "text/csv":
        return { kind: "csv" };
    }
  }
  throw new PgRestError(
    415,
    "PGRST107",
    "None of these media types are available: " + entries.map((e) => e.type).join(", "),
  );
};

export type BodyKind = "json" | "urlencoded" | "csv";

/** Decode the request body into a JSON string (array of objects, or an object). */
export const parseBody = async (
  request: Request,
  method: Method,
): Promise<{ readonly kind: BodyKind; readonly value: unknown } | undefined> => {
  // Only writes carry a payload; GET/HEAD/DELETE/OPTIONS bodies are ignored.
  if (method !== "POST" && method !== "PATCH" && method !== "PUT") return undefined;
  const ct = (request.headers.get("content-type") ?? "application/json").split(";")[0]!.trim().toLowerCase();
  const text = await request.text();

  if (ct === "application/json" || ct === "application/vnd.pgrst.array+json") {
    if (text.trim() === "") return undefined;
    try {
      return { kind: "json", value: JSON.parse(text) };
    } catch (e) {
      throw new PgRestError(400, "PGRST102", "Empty or invalid json", e instanceof Error ? e.message : null);
    }
  }
  if (ct === "application/x-www-form-urlencoded") {
    const obj: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) obj[k] = v;
    return { kind: "urlencoded", value: obj };
  }
  if (ct === "text/csv") {
    return { kind: "csv", value: parseCsv(text) };
  }
  throw new PgRestError(415, "PGRST107", `Content-Type not acceptable: ${ct}`);
};

/** Minimal RFC 4180 CSV → array of objects (first row is the header). */
export const parseCsv = (text: string): Array<Record<string, string | null>> => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    sawAny = true;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAny = false;
    } else field += ch;
  }
  if (sawAny || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...data] = rows;
  if (!header) return [];
  if (header.some((h) => h === "")) throw parseError("Invalid CSV", "the header row has an empty column name");
  return data
    .filter((r) => !(r.length === 1 && r[0] === ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === "" || r[i] === undefined ? null : r[i]!])));
};
