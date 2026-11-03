#!/usr/bin/env bash
# Start an example server, run the same requests against it, stop it.
#   scripts/check-example.sh with-node-postgres postgres://user:pw@host:5432/dbname
set -euo pipefail
name="$1"; export DATABASE_URL="${2:-}"; port="${PORT:-3101}"; export PORT="$port"
dir="$(cd "$(dirname "$0")/../examples/$name" && pwd)"
cd "$dir"
if [ "$name" = with-bun ]; then bun install >/dev/null; bun run server.ts >/tmp/$name.log 2>&1 & else npm install --no-audit --no-fund >/dev/null; node server.ts >/tmp/$name.log 2>&1 & fi
pid=$!; trap 'kill $pid 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -fs "localhost:$port/todos?limit=1" >/dev/null 2>&1 && break; sleep 0.5; done
u="localhost:$port"; fail=0
# how "alice" identifies herself: a header in most examples, a real session cookie with Better Auth
ALICE=(-H 'X-User: alice')
if [ "$name" = with-better-auth ]; then
  jar="$(mktemp)"
  curl -s -c "$jar" "$u/api/auth/sign-up/email" -H 'Content-Type: application/json' -d '{"name":"Alice","email":"alice@example.com","password":"correct horse battery"}' >/dev/null
  ALICE=(-b "$jar")
fi
check() { # description, expected, actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$2] got [$3]"; fail=1; fi
}
check "anon read with embed" '[{"id":1,"title":"Try pg-rest","tags":[{"label":"demo"},{"label":"bun"}]}]' "$(curl -s "$u/todos?select=id,title,tags(label)&id=eq.1" | tr -d '\n' | sed 's/, */,/g; s/\[ */[/; s/ *\]/]/g')"
check "anon write is refused (401)" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$u/todos" -H 'Content-Type: application/json' -d '{"title":"nope"}')"
created="$(curl -s -w '\n%{http_code}' "$u/todos" "${ALICE[@]}" -H 'Content-Type: application/json' -H 'Prefer: return=representation' -d '{"title":"Ship it"}')"
check "alice creates a todo (201)" 201 "$(echo "$created" | tail -1)"
id="$(echo "$created" | head -n -1 | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)"
check "alice cannot touch bob's row (RLS)" '[]' "$(curl -s -X PATCH "$u/todos?id=eq.2" "${ALICE[@]}" -H 'Content-Type: application/json' -H 'Prefer: return=representation' -d '{"done":true}')"
check "alice updates her row" 1 "$(curl -s -X PATCH "$u/todos?id=eq.$id" "${ALICE[@]}" -H 'Content-Type: application/json' -H 'Prefer: return=representation' -d '{"done":true}' | grep -o '"done":true' | wc -l | tr -d ' ')"
check "rpc: open todos" 2 "$(curl -s "$u/rpc/open_todos" | grep -o '"title"' | wc -l | tr -d ' ')"
check "count + range (206)" "206 0-0/3" "$(curl -s -o /dev/null -D - "$u/todos?limit=1&order=id" -H 'Prefer: count=exact' | tr -d '\r' | awk 'NR==1{c=$2} tolower($1)=="content-range:"{r=$2} END{print c" "r}')"
check "openapi" '"swagger":"2.0"' "$(curl -s "$u/" | grep -o '"swagger":"2.0"')"
exit $fail
