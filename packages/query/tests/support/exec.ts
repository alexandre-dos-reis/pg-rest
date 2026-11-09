import type { QueryInput, QueryInstance, QueryResult, RequestContext } from "../../src/index";

/**
 * Run an input whose operation is only known at run time (a table-driven test): the one place a test
 * dispatches on `action` itself, the way the six methods do.
 */
export const exec = <T = unknown>(
  api: QueryInstance,
  input: QueryInput,
  ctx?: RequestContext,
): Promise<QueryResult<T>> => {
  const op = "name" in input ? "rpc" : (input.action ?? "select");
  return (api as unknown as Record<string, (i: QueryInput, c?: RequestContext) => Promise<QueryResult<T>>>)[op]!(
    input,
    ctx,
  );
};
