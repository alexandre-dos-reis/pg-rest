# pg-rest + Better Auth

The same todo API with Row Level Security, but the caller is a real user signed in with [Better Auth](https://better-auth.com)
(email + password, session cookie) instead of a demo header. This folder is self-contained: copy it anywhere.

```sh
docker compose up -d      # Postgres 16 with 1-better-auth.sql, then 2-api.sql loaded
npm install
node server.ts            # Node >= 22.18 runs TypeScript natively
```

`pg-rest` is an ordinary versioned dependency, so once this folder is copied out of the repository the
install above is all you need. Inside the repository that version is not on the registry yet and will not
resolve, so link the local build instead -- from the repository root:

```sh
bun run link:examples with-better-auth   # builds pg-rest, then symlinks it into node_modules
```

## How it fits together

`server.ts` is the whole integration, and the interesting part is one function:

```ts
resolveContext: async (req) => {
  const session = await auth.api.getSession({ headers: req.headers });   // Better Auth reads the session cookie
  return session ? { role: "authenticated", claims: { sub: session.user.id, email: session.user.email } } : undefined;
},
```

- No session → `undefined` → pg-rest runs the request as the `anon` role (read-only in `2-api.sql`).
- Session → role `authenticated`, and `claims.sub` is the Better Auth user id, which the RLS policies read through `auth.uid()` (a small SQL function in `2-api.sql` over
  `current_setting('request.jwt.claims')`).
- A Hono app routes `/api/auth/*` to Better Auth and `/api/rest/*` to pg-rest (anything else is a 404). Both share one `pg.Pool`.
- Two SQL files, run in order: `1-better-auth.sql` creates Better Auth's tables (`"user"`, `session`, `account`, `verification`, the same DDL its
  own migrations generate), then `2-api.sql` creates the `api` schema. That order lets `api.todos.owner_id` be a real foreign key to
  `public."user"(id)` (deleting a user deletes their todos). The two seeded todos have no owner: readable by all, writable by nobody.
- Better Auth's tables live in the `public` schema; pg-rest only exposes `api`, so users and sessions are not reachable through the REST API.

pg-rest has no CSRF protection of its own. If browsers call it with cookies, apply your usual CSRF defences (SameSite cookies, an `Origin` check)
in middleware on the Hono app or in `resolveContext`.

## Server-side, without HTTP

Code in this process does not have to call itself over the network. `@tsql/query` runs the same database from an object —
a second instance next to the handler, built from a schema generated at build time (see below) — and takes the caller:

```ts
app.get("/dashboard", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const ctx = session ? { role: "authenticated", claims: { sub: session.user.id } } : undefined;

  const { data: todos, error } = await pgRest.query(
    {
      table: "todos",
      select: ["id", "title", "done", { tags: ["label"] }],
      where: { done: false },
      order: [{ column: "created", desc: true }],
      limit: 10,
    },
    ctx,
  );
  if (error) return c.json({ error: error.message, kind: error.kind }, 500);

  return c.json(todos);
});
```

Same role, same claims, same RLS policies as the REST route: `anon` without a session (the two seeded todos), the user's own
rows with one. A `select` without `basePath`, without a `Request` and without parsing a response — and a failure comes
back as `error`, with a `kind` to switch on and the `message`, ready to answer with. See [`docs/query.md`](../../docs/query.md).

Generate the module for this schema once (`generateModule(await introspect(adapter, ["api"]))`, from `@tsql/query/types`), pass
its `schema` to `createQuery<DatabasePgRest>({ … })`, and the query above checks itself: `"todos"` and its columns, `tags` as a real
relationship, `done` as a boolean — with `data` inferred as
`Array<{ id: number; title: string; done: boolean; tags: Array<{ label: string }> }>`. See
[`docs/types.md`](../../docs/types.md).

## Try it

```sh
# sign up (the session cookie is saved in cookies.txt)
curl -c cookies.txt localhost:3000/api/auth/sign-up/email -H 'Content-Type: application/json' \
     -d '{"name":"Alice","email":"alice@example.com","password":"correct horse battery"}'

# anonymous: read-only
curl 'localhost:3000/api/rest/todos?select=id,title,tags(label)'
curl 'localhost:3000/api/rest/todos' -H 'Content-Type: application/json' -d '{"title":"nope"}'      # 401, code 42501

# signed in: rows you create are owned by your Better Auth user id
curl -b cookies.txt 'localhost:3000/api/rest/todos' -H 'Content-Type: application/json' \
     -H 'Prefer: return=representation' -d '{"title":"Ship it"}'
curl -b cookies.txt -X PATCH 'localhost:3000/api/rest/todos?id=eq.2' -H 'Content-Type: application/json' \
     -H 'Prefer: return=representation' -d '{"done":true}'                                 # [] : not your row (RLS)
```
