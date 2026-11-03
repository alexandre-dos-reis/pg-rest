# Example

A tiny todo API with Row Level Security.

```sh
cd example && docker compose up -d && cd ..     # Postgres 16 with schema.sql loaded
bun install
bun run example/server.ts                       # http://localhost:3000
```

(No Docker? Create a database, then `psql "$DATABASE_URL" -f example/schema.sql` and export `DATABASE_URL`.)

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
