# pg-rest + PGlite

A tiny todo API with Row Level Security on **Node.js**, using PGlite (Postgres in WebAssembly, no database server).
This folder is self-contained: copy it anywhere.

```sh
# no database to start: the schema is loaded in memory when the server starts
npm install
node server.ts      # Node >= 22.18 runs TypeScript natively
```

The `pg-rest` dependency points at the repository root (`file:../..`), so build it once first: `bun run build` in the repository root. In your own project install it from npm instead.

`server.ts` is the whole integration: create the driver, wrap it in the adapter from `pg-rest/adapters/...`, give `createPgRest` a way to resolve the caller
(`resolveContext`), and hand `api.handle` to any server that speaks `Request`/`Response`.

Try it — the caller is whoever `X-User` says (see `resolveContext` in `server.ts`):

```sh
# anonymous: read-only
curl 'localhost:3000/todos?select=id,title,tags(label)'
curl 'localhost:3000/todos' -H 'Content-Type: application/json' -d '{"title":"nope"}'   # 401, code 42501 (permission denied)

# as alice: create, update, delete her own rows
curl 'localhost:3000/todos' -H 'X-User: alice' -H 'Content-Type: application/json' \
     -H 'Prefer: return=representation' -d '{"title":"Ship it"}'
curl -X PATCH 'localhost:3000/todos?id=eq.1' -H 'X-User: alice' -H 'Content-Type: application/json' -d '{"done":true}'
curl -X PATCH 'localhost:3000/todos?id=eq.2' -H 'X-User: alice' -H 'Content-Type: application/json' -d '{"done":true}' -H 'Prefer: return=representation'  # [] : bob's row is invisible to alice (RLS)

# filters, ordering, paging, count, RPC
curl 'localhost:3000/todos?done=is.false&order=created.desc&limit=5' -H 'Prefer: count=exact' -i
curl 'localhost:3000/rpc/open_todos'
curl 'localhost:3000/'                            # OpenAPI document
```
