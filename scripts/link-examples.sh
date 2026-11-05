#!/usr/bin/env bash
# Point the examples at the local build instead of the published pg-rest, without committing anything local
# (so check-example-versions.ts stays happy).
#   scripts/link-examples.sh                      all examples
#   scripts/link-examples.sh with-better-auth     just one
#   scripts/link-examples.sh --unlink             back to the version in package.json
#
# The examples depend on pg-rest by version, and that version is usually not on the registry yet, so a plain
# `bun install` would 404 before it ever got to `bun link`. The other dependencies are installed with pg-rest
# held out of package.json, which is then put straight back.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

# The package name comes from package.json: hardcoding it meant a rename left the examples resolving
# the published version from the registry, which has none of the unreleased API.
pkg="$(node -p 'require("./package.json").name')"

unlink=0
if [ "${1:-}" = "--unlink" ]; then unlink=1; shift; fi
if [ "$#" -gt 0 ]; then names=("$@"); else names=($(ls examples)); fi

for name in "${names[@]}"; do
  [ -d "examples/$name" ] || { echo "no such example: $name" >&2; exit 1; }
done

if [ "$unlink" = 0 ]; then
  bun run build >/dev/null   # the examples import ./dist, so it has to exist
  bun link >/dev/null        # register "pg-rest" once, globally
fi

for name in "${names[@]}"; do
  dir="examples/$name"

  if [ "$unlink" = 1 ]; then
    (cd "$dir" && { bun unlink "$pkg" >/dev/null 2>&1 || true; }; rm -rf "node_modules/$pkg")
    echo "unlinked $name"
    continue
  fi

  # Restore package.json whatever happens next -- it is a tracked file.
  backup="$(mktemp)"
  cp "$dir/package.json" "$backup"
  trap 'cp "$backup" "$dir/package.json"; rm -f "$backup"' EXIT

  node -e '
    const fs = require("node:fs");
    const [f, name] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(f, "utf8"));
    delete pkg.dependencies?.[name];
    fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + "\n");
  ' "$dir/package.json" "$pkg"

  # A lockfile pinning the unpublished version would make bun try the registry again.
  rm -f "$dir/bun.lock"
  # ... and so would a copy of the published package left over from an earlier install.
  rm -rf "$dir/node_modules/$pkg"
  (cd "$dir" && bun install >/dev/null)

  cp "$backup" "$dir/package.json"
  rm -f "$backup"
  trap - EXIT

  # Symlinks over the version dependency; package.json is left alone.
  (cd "$dir" && bun link "$pkg" >/dev/null)

  # `bun link` can report success while leaving nothing usable behind (a stale global registration points
  # somewhere else, or the link lands but dist/ is absent), so the result is checked rather than assumed.
  link="$dir/node_modules/$pkg"
  [ -L "$link" ] || { echo "FAIL $name: $link is not a symlink -- is 'bun link' registered at the repo root?" >&2; exit 1; }
  [ -f "$link/package.json" ] || { echo "FAIL $name: $link -> $(readlink "$link") is dangling" >&2; exit 1; }
  [ -f "$link/dist/index.js" ] || { echo "FAIL $name: $link has no dist/index.js -- run 'bun run build'" >&2; exit 1; }
  (cd "$dir" && node -e "import(\"$pkg\")" 2>/dev/null) ||
    { echo "FAIL $name: $pkg is linked but does not resolve" >&2; exit 1; }
  echo "linked   $name -> $(readlink "$link")"
done
