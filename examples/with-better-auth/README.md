# pg-rest + Better Auth

The same todo API with Row Level Security, but the caller is a real user signed in with [Better Auth](https://better-auth.com)
(email + password, session cookie) instead of a demo header. This folder is self-contained: copy it anywhere.

```sh
docker compose up -d      # Postgres 16 with 1-better-auth.sql, then 2-api.sql loaded
npm install
node server.ts            # Node >= 22.18 runs TypeScript natively
```

The `pg-rest` dependency points at the repository root (`file:../..`), so build it once first: `bun run build` in the repository root.
In your own project install it from npm instead.

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
- Requests under `/api/auth/*` go to Better Auth; everything else goes to pg-rest. Both share one `pg.Pool`.
- Two SQL files, run in order: `1-better-auth.sql` creates Better Auth's tables (`"user"`, `session`, `account`, `verification`, the same DDL its
  own migrations generate), then `2-api.sql` creates the `api` schema. That order lets `api.todos.owner_id` be a real foreign key to
  `public."user"(id)` (deleting a user deletes their todos). The two seeded todos have no owner: readable by all, writable by nobody.
- Better Auth's tables live in the `public` schema; pg-rest only exposes `api`, so users and sessions are not reachable through the REST API.

pg-rest has no CSRF protection of its own. If browsers call it with cookies, apply your usual CSRF defences (SameSite cookies, an `Origin` check)
in the `fetch` handler or in `resolveContext`.

## Try it

```sh
# sign up (the session cookie is saved in cookies.txt)
curl -c cookies.txt localhost:3000/api/auth/sign-up/email -H 'Content-Type: application/json' \
     -d '{"name":"Alice","email":"alice@example.com","password":"correct horse battery"}'

# anonymous: read-only
curl 'localhost:3000/todos?select=id,title,tags(label)'
curl 'localhost:3000/todos' -H 'Content-Type: application/json' -d '{"title":"nope"}'      # 401, code 42501

# signed in: rows you create are owned by your Better Auth user id
curl -b cookies.txt 'localhost:3000/todos' -H 'Content-Type: application/json' \
     -H 'Prefer: return=representation' -d '{"title":"Ship it"}'
curl -b cookies.txt -X PATCH 'localhost:3000/todos?id=eq.2' -H 'Content-Type: application/json' \
     -H 'Prefer: return=representation' -d '{"done":true}'                                 # [] : not your row (RLS)
```
