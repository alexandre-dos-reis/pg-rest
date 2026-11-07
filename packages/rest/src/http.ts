import {
  type Caller,
  type CoreConfig,
  type Env,
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
import {
  type Method,
  parseAccept,
  parseBody,
  isSupportedMethod,
  parseMethod,
  parsePrefer,
  parseRange,
  parseTarget,
} from "@tsql/core/parse/request";
import { getRelation } from "@tsql/core/schema";
import { mediaChoices } from "./media";
import { buildOpenApi } from "./openapi";

/** What only the HTTP entry point reads, on top of what both entry points share. */
export interface HttpConfig extends CoreConfig {
  readonly basePath: string;
  /** Honor `Prefer: tx=rollback|commit` (PostgREST `db-tx-end`). */
  readonly allowTxOverride: boolean;
  /** Answer `Accept: application/vnd.pgrst.plan` with the query plan. */
  readonly planEnabled: boolean;
  readonly openApi: boolean;
  readonly serverUrl?: string | undefined;
}

export interface HttpEnv extends Env {
  readonly config: HttpConfig;
}

const JSON_CT = "application/json; charset=utf-8";

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
  const wantsPlan = requested.kind === "plan" ? requested : undefined;
  const range = parseRange(request.headers.get("range"), request.headers.get("range-unit"));
  const body = await parseBody(request, method);

  const qp: QueryParams = { params: [...url.searchParams], bare: bareKeys(url.search) };
  let plan: Plan;
  if (target.type === "table") {
    plan = planTable(env, method, schema, target.name, qp, prefer, format, range, body);
  } else {
    plan = planRpc(env, method, schema, target.name, qp, prefer, format, range, body);
  }

  const caller: Caller = { path: url.pathname, headers: request.headers, request };
  return execute(env, ctx, caller, method, schema, prefer, format, plan, honoredTx, wantsPlan);
};
