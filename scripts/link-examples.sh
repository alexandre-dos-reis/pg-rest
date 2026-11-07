#!/usr/bin/env bash
# Point the examples at the local build instead of the published @tsql/rest and @tsql/query, without committing anything local
# (so check-example-versions.ts stays happy).
#   scripts/link-examples.sh                      all examples
#   scripts/link-examples.sh with-better-auth     just one (or rest/with-better-auth)
#   scripts/link-examples.sh --unlink             back to the version in package.json
#
# The examples depend on the packages by version, and that version is usually not on the registry yet, so a plain
# `bun install` would 404 before it ever got to `bun link`. The other dependencies are installed with the @tsql
# packages held out of package.json, which is then put straight back.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

# The packages an example uses are the @tsql/* entries of its dependencies: the handlers use @tsql/rest, the
# query examples @tsql/query. Each one is a directory under packages/ (the name after the scope).
scoped() { node -p 'Object.keys(require(require("path").resolve(process.argv[1])).dependencies ?? {}).filter((d) => d.startsWith("@tsql/")).join(" ")' "$1/package.json"; }

unlink=0
if [ "${1:-}" = "--unlink" ]; then unlink=1; shift; fi
# Examples live in examples/rest/* and examples/query/*, and are named by the directory alone
# (with-bun) or with the group (rest/with-bun).
find_example() { for d in "examples/$1" examples/*/"$1"; do [ -f "$d/package.json" ] && { echo "$d"; return 0; }; done; return 1; }
if [ "$#" -gt 0 ]; then names=("$@"); else names=($(ls -d examples/*/*/ | sed 's#examples/##; s#/$##')); fi

for name in "${names[@]}"; do
  find_example "$name" >/dev/null || { echo "no such example: $name" >&2; exit 1; }
done

if [ "$unlink" = 0 ]; then
  bun run build >/dev/null   # the examples import ./dist, so it has to exist
  for pkgdir in packages/rest packages/query; do
    (cd "$pkgdir" && bun link >/dev/null)   # register "@tsql/rest" and "@tsql/query" once, globally
  done
fi

for name in "${names[@]}"; do
  dir="$(find_example "$name")"
  pkgs="$(scoped "$dir")"

  if [ "$unlink" = 1 ]; then
    for pkg in $pkgs; do
      (cd "$dir" && { bun unlink "$pkg" >/dev/null 2>&1 || true; }; rm -rf "node_modules/$pkg")
    done
    echo "unlinked $name"
    continue
  fi

  # Restore package.json whatever happens next -- it is a tracked file.
  backup="$(mktemp)"
  cp "$dir/package.json" "$backup"
  trap 'cp "$backup" "$dir/package.json"; rm -f "$backup"' EXIT

  node -e '
    const fs = require("node:fs");
    const [f, ...names] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const name of names) delete pkg.dependencies?.[name];
    fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + "\n");
  ' "$dir/package.json" $pkgs

  # A lockfile pinning the unpublished version would make bun try the registry again.
  rm -f "$dir/bun.lock"
  # ... and so would a copy of the published package left over from an earlier install.
  for pkg in $pkgs; do rm -rf "$dir/node_modules/$pkg"; done
  (cd "$dir" && bun install >/dev/null)

  cp "$backup" "$dir/package.json"
  rm -f "$backup"
  trap - EXIT

  for pkg in $pkgs; do
    # Symlinks over the version dependency; package.json is left alone.
    (cd "$dir" && bun link "$pkg" >/dev/null)

    # `bun link` can report success while leaving nothing usable behind (a stale global registration points
    # somewhere else, or the link lands but dist/ is absent), so the result is checked rather than assumed.
    link="$dir/node_modules/$pkg"
    [ -L "$link" ] || { echo "FAIL $name: $link is not a symlink -- is 'bun link' registered in packages/?" >&2; exit 1; }
    [ -f "$link/package.json" ] || { echo "FAIL $name: $link -> $(readlink "$link") is dangling" >&2; exit 1; }
    [ -f "$link/dist/index.js" ] || { echo "FAIL $name: $link has no dist/index.js -- run 'bun run build'" >&2; exit 1; }
    (cd "$dir" && node -e "import(\"$pkg\")" 2>/dev/null) ||
      { echo "FAIL $name: $pkg is linked but does not resolve" >&2; exit 1; }
    echo "linked   $name: $pkg -> $(readlink "$link")"
  done
done
