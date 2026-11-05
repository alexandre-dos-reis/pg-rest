#!/usr/bin/env bash
# Run an example end to end: start its server and send the same requests to it, or -- for an example
# that has no server -- run its scripts and check what they produce.
#   scripts/check-example.sh with-node-postgres postgres://user:pw@host:5432/dbname
#   scripts/check-example.sh with-generated-types
set -euo pipefail
name="$1"; export DATABASE_URL="${2:-}"; port="${PORT:-3101}"; export PORT="$port"
root="$(cd "$(dirname "$0")/.." && pwd)"
# pg-rest is a version dependency, and the version in package.json is usually not on the registry
# yet, so the example runs against the local build.
"$root/scripts/link-examples.sh" "$name" >/dev/null
cd "$root/examples/$name"

check() { # description, expected, actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$2] got [$3]"; fail=1; fi
}

# An example without a server is a pair of scripts: generate the types, then use them.
if [ ! -f server.ts ]; then
  fail=0
  bun run gen:types >/dev/null
  # the generated file is committed, so the generator's output for this schema is pinned here
  # (only that file: the rest of the example may legitimately differ in a working tree)
  check "the generated types are what is committed" "" "$(cd "$root" && git diff --name-only -- "examples/$name/db.types.ts")"
  # every @ts-expect-error in mistakes.ts has to still be an error, and main.ts has to compile
  tsc_out="$(bun run typecheck 2>&1)" || { echo "FAIL typecheck:"; echo "$tsc_out"; exit 1; }
  check "the typed queries compile, the mistakes do not" 0 $?
  out="$(bun start 2>&1)"
  check "a typed read" "Try pg-rest (high) demo, types" "$(echo "$out" | grep -o 'Try pg-rest (high) demo, types')"
  check "a typed insert" 201 "$(echo "$out" | grep -o 'created 201' | grep -o 201)"
  check "a typed rpc" 2 "$(echo "$out" | grep -c "^rpc open_todos:\|^single:")"
  exit $fail
fi
if [ "$name" = with-bun ]; then bun run server.ts >/tmp/$name.log 2>&1 & else node server.ts >/tmp/$name.log 2>&1 & fi
pid=$!; trap 'kill $pid 2>/dev/null || true' EXIT
# with-better-auth mounts pg-rest under a basePath, to share the port with Better Auth.
base=""
if [ "$name" = with-better-auth ]; then base="/api/rest"; fi
u="localhost:$port$base"; fail=0
for i in $(seq 1 60); do curl -fs "$u/todos?limit=1" >/dev/null 2>&1 && break; sleep 0.5; done
# how "alice" identifies herself: a header in most examples, a real session cookie with Better Auth
ALICE=(-H 'X-User: alice')
if [ "$name" = with-better-auth ]; then
  jar="$(mktemp)"
  curl -s -c "$jar" "localhost:$port/api/auth/sign-up/email" -H 'Content-Type: application/json' -d '{"name":"Alice","email":"alice@example.com","password":"correct horse battery"}' >/dev/null
  ALICE=(-b "$jar")
fi
check "anon read with embed" '[{"id":1,"title":"Try pg-rest","tags":[{"label":"demo"},{"label":"bun"}]}]' "$(curl -s "$u/todos?select=id,title,tags(label)&id=eq.1" | tr -d '\n' | sed 's/, */,/g; s/": /":/g; s/\[ */[/; s/ *\]/]/g')"
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
