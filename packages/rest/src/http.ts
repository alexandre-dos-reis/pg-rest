import {
  type Caller,
  type CoreConfig,
  type Env,
  type Outcome,
  type Plan,
  type QueryParams,
  type RequestContext,
  assertRole,
  execute,
  planRpc,
  planTable,
  useSchema,
} from "@tsql/core/core";
import { PgRestError } from "@tsql/core/errors";
import type { Method } from "@tsql/core/parse/request";
import { getRelation } from "@tsql/core/schema";
import { mediaChoices } from "./media";
import { buildOpenApi } from "./openapi";
import {
  parseAccept,
  parseBody,
  isSupportedMethod,
  parseMethod,
  parsePrefer,
  parseRange,
  parseTarget,
  type Negotiated,
} from "./request";
import { toEngineFormat } from "./render";

/** What only the HTTP entry point reads, on top of what both entry points share. */
export interface HttpConfig extends CoreConfig {
  readonly basePath: string;
  /** Honor `Prefer: tx=rollback|commit` (PostgREST `db-tx-end`). */
  readonly allowTxOverride: boolean;
  /** Answer `Accept: application/vnd.pgrst.plan` with the query plan. */
  readonly planEnabled: boolean;
  readonly openApi: boolean;
  /** Expose `request.headers`, `request.cookies`, `request.method`, `request.path` to SQL. */
  readonly requestSettings: boolean;
  readonly serverUrl?: string | undefined;
}

export interface HttpEnv extends Env {
  readonly config: HttpConfig;
}

const JSON_CT = "application/json; charset=utf-8";

/** The `Cookie` header as `request.cookies` reads it: a name -> value record. */
const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const v = part
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, "");
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
};

/**
 * An {@link Outcome} dressed for HTTP: the headers that are only transport (`Vary`, `Content-Type`), the
 * body dropped where HTTP says there is none, and the bytes of a `bytea` handler.
 */
const toResponse = (
  outcome: Outcome,
  method: Method,
  format: Negotiated,
  plan: Plan,
  wantsPlan: Extract<Negotiated, { kind: "plan" }> | undefined,
): Response => {
  if (wantsPlan) {
    const opts = wantsPlan.options.length ? `; options=${wantsPlan.options.join("|")}` : "";
    return new Response(method === "HEAD" ? null : outcome.text, {
      status: 200,
      headers: {
        "Content-Type": `application/vnd.pgrst.plan+${wantsPlan.format}; for="${wantsPlan.forType}"${opts}; charset=utf-8`,
        Vary: "Accept, Prefer, Range",
      },
    });
  }
  const { status, text } = outcome;
  const headers: Record<string, string> = { Vary: "Accept, Prefer, Range", ...outcome.headers };

  let contentType = JSON_CT;
  if (format.kind === "handler") {
    contentType = format.choice.contentType;
  } else if (format.kind === "csv") {
    contentType = "text/csv; charset=utf-8";
  } else if (format.kind === "geojson") {
    contentType = "application/geo+json; charset=utf-8";
  } else if (format.kind === "object") {
    contentType = `application/vnd.pgrst.object+json${format.stripNulls ? ";nulls=stripped" : ""}; charset=utf-8`;
  } else if (format.kind === "json" && format.stripNulls) {
    contentType = "application/vnd.pgrst.array+json;nulls=stripped; charset=utf-8";
  }

  const noBody = status === 204 || status === 304 || text === "" || method === "HEAD";
  if (
    !(
      status === 204 ||
      status === 304 ||
      (text === "" && method !== "HEAD" && !(format.kind === "handler" && plan.kind === "read"))
    )
  )
    headers["Content-Type"] = contentType;
  if (!noBody && format.kind === "handler" && format.choice.bytea) {
    return new Response(Buffer.from(text, "hex"), { status, headers });
  }
  return new Response(noBody ? null : text, { status, headers });
};

/** The bare keys of a query string: `?a&b=1` -> `{a}`. They are arguments, never filters. */
export const bareKeys = (search: string): Set<string> => {
  const out = new Set<string>();
  for (const kv of search.slice(1).split("&")) {
    if (kv !== "" && !kv.includes("=")) out.add(decodeURIComponent(kv));
  }
  return out;
};

const readSchema = (env: HttpEnv, request: Request, method: Method): string =>
  useSchema(
    env,
    method === "GET" || method === "HEAD"
      ? request.headers.get("accept-profile")
      : request.headers.get("content-profile"),
  );

export const handleRequest = async (env: HttpEnv, request: Request, ctx: RequestContext): Promise<Response> => {
  assertRole(env, ctx);
  // like PostgREST's web server, answer other methods (TRACE...) with an empty 405
  if (!isSupportedMethod(request.method))
    return new Response(null, { status: 405, headers: { "Content-Type": JSON_CT } });
  const method = parseMethod(request.method);
  const url = new URL(request.url);
  const target = parseTarget(url.pathname, env.config.basePath);
  const schema = readSchema(env, request, method);
  const prefer = parsePrefer(request.headers.get("prefer"));
  const invalid = [...prefer.invalid];
  const honoredTx = env.config.allowTxOverride;
  if (prefer.tx && !honoredTx) invalid.push(`tx=${prefer.tx}`);
  if (prefer.handling === "strict" && invalid.length > 0) {
    throw new PgRestError(
      400,
      "PGRST122",
      "Invalid preferences given with handling=strict",
      `Invalid preferences: ${invalid.join(", ")}`,
    );
  }

  if (method === "OPTIONS") {
    const allow =
      target.type === "root"
        ? "OPTIONS,GET,HEAD"
        : target.type === "rpc"
          ? "OPTIONS,GET,HEAD,POST"
          : (() => {
              const rel = getRelation(env.cache, schema, target.name);
              const m = ["OPTIONS", "GET", "HEAD"];
              if (rel.insertable) m.push("POST");
              if (rel.insertable && rel.updatable) m.push("PUT");
              if (rel.updatable) m.push("PATCH");
              if (rel.deletable) m.push("DELETE");
              return m.join(",");
            })();
    return new Response(null, { status: 200, headers: { Allow: allow } });
  }

  if (target.type === "root") {
    if (method !== "GET" && method !== "HEAD")
      throw new PgRestError(405, "PGRST117", `Unsupported HTTP method: ${method}`);
    if (!env.config.openApi) throw new PgRestError(404, "PGRST126", "Root endpoint metadata is disabled");
    parseAccept(request.headers.get("accept"), true);
    const doc = buildOpenApi(env.cache, schema, {
      serverUrl: env.config.serverUrl ?? url.origin,
      basePath: env.config.basePath,
    });
    return new Response(method === "HEAD" ? null : JSON.stringify(doc), {
      status: 200,
      headers: { "Content-Type": "application/openapi+json; charset=utf-8" },
    });
  }

  const requested = parseAccept(
    request.headers.get("accept"),
    false,
    env.config.planEnabled,
    mediaChoices(env.cache, schema, target, url.searchParams.has("select")),
  );
  const format = requested.kind === "plan" ? requested.inner : requested;
  const engineFormat = toEngineFormat(format);
  const wantsPlan = requested.kind === "plan" ? requested : undefined;
  const range = parseRange(request.headers.get("range"), request.headers.get("range-unit"));
  const body = await parseBody(request, method);

  const qp: QueryParams = { params: [...url.searchParams], bare: bareKeys(url.search) };
  let plan: Plan;
  if (target.type === "table") {
    plan = planTable(env, method, schema, target.name, qp, prefer, engineFormat, range, body);
  } else {
    plan = planRpc(env, method, schema, target.name, qp, prefer, engineFormat, range, body);
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const caller: Caller = {
    path: url.pathname,
    request,
    http: env.config.requestSettings ? { headers, cookies: parseCookies(request.headers.get("cookie")) } : undefined,
  };
  const outcome = await execute(env, ctx, caller, method, schema, prefer, engineFormat, plan, honoredTx, wantsPlan);
  return toResponse(outcome, method, format, plan, wantsPlan);
};
