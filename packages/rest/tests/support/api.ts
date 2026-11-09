// `@tsql/rest`'s harness: a throwaway database, `createRest` on it, and the HTTP helpers a suite
// drives `handle()` with. It names `@tsql/rest` and `@tsql/core` and nothing else -- what the other
// package does with the same database is not this package's business.
import { createRest, type RequestContext, type RestInstance, type RestOptions } from "../../src/index";
import { createTestDb, type TestDb } from "../../../../tests/support/db";

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** Parsed JSON body (throws if the body is not JSON). */
  json<T = any>(): T;
}

export interface CallOptions {
  readonly headers?: Record<string, string>;
  /** Objects are sent as JSON; strings are sent as-is. */
  readonly body?: unknown;
  readonly ctx?: RequestContext;
}

export interface TestApi {
  readonly db: TestDb;
  readonly api: RestInstance;
  call(method: string, path: string, opts?: CallOptions): Promise<Reply>;
  get(path: string, opts?: CallOptions): Promise<Reply>;
  post(path: string, body: unknown, opts?: CallOptions): Promise<Reply>;
  patch(path: string, body: unknown, opts?: CallOptions): Promise<Reply>;
  put(path: string, body: unknown, opts?: CallOptions): Promise<Reply>;
  del(path: string, opts?: CallOptions): Promise<Reply>;
  close(): Promise<void>;
}

/** The user used by tests that write: the `authenticated` role. */
export const authed = (sub = "user-1"): RequestContext => ({ role: "authenticated", claims: { sub } });

export const makeApi = async (options: Partial<RestOptions> = {}): Promise<TestApi> => {
  const db = await createTestDb();
  const api = await createRest({ db: db.adapter, schemas: ["api", "v2"], ...options });

  const call = async (method: string, path: string, opts: CallOptions = {}): Promise<Reply> => {
    const headers: Record<string, string> = { ...opts.headers };
    let body: string | undefined;
    if (opts.body !== undefined) {
      if (typeof opts.body === "string") body = opts.body;
      else {
        body = JSON.stringify(opts.body);
        headers["Content-Type"] ??= "application/json";
      }
    }
    const res = await api.handle(
      new Request(`http://localhost${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }),
      opts.ctx,
    );
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  };

  return {
    db,
    api,
    call,
    get: (p, o) => call("GET", p, o),
    post: (p, b, o) => call("POST", p, { ...o, body: b }),
    patch: (p, b, o) => call("PATCH", p, { ...o, body: b }),
    put: (p, b, o) => call("PUT", p, { ...o, body: b }),
    del: (p, o) => call("DELETE", p, o),
    async close() {
      await api.close();
      await db.drop();
    },
  };
};
