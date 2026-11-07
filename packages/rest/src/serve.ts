import type { DbAdapter } from "@tsql/core/adapter";
import type { RequestContext } from "@tsql/core/core";
import { DbQueryError, EngineError } from "@tsql/core/errors";
import { type ApiError, PgRestError, toApiError } from "./errors";
import type { SchemaCache } from "@tsql/core/schema";
import { type HttpConfig, handleRequest } from "./http";

export const errorResponse = (err: ApiError): Response =>
  new Response(JSON.stringify(err.body), {
    status: err.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // every 401 invites the client to authenticate, like PostgREST
      ...(err.status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
      ...err.headers,
    },
  });

/** Handle a request. Never rejects: errors become PostgREST-style JSON responses. */
export const handleSafely = async (
  env: { readonly db: DbAdapter; readonly config: HttpConfig; readonly cache: SchemaCache },
  request: Request,
  ctx: RequestContext,
): Promise<Response> => {
  try {
    return await handleRequest(env, request, ctx);
  } catch (e) {
    const api = toApiError(e, ctx.role ?? env.config.anonymousRole, env.config.anonymousRole);
    if (
      api.status >= 500 &&
      !(e instanceof PgRestError) &&
      !(e instanceof EngineError) &&
      !(e instanceof DbQueryError)
    ) {
      console.error("pg-rest: unexpected error while handling a request", e);
    }
    return errorResponse(api);
  }
};
