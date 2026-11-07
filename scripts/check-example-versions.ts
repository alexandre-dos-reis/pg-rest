// Every examples/*/*/package.json must depend on the packages it uses at the version in packages/*/package.json,
// the way a real project would -- never on a local path (file:/link:/workspace:), which must not be committed.
// The names and versions are read from packages/*/package.json, so renaming a package needs no edit here.
//   bun run scripts/check-example-versions.ts        (or: node scripts/check-example-versions.ts)
//   bun run scripts/check-example-versions.ts --fix  rewrites the examples to the expected spec
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (url: URL) => JSON.parse(readFileSync(url, "utf8")) as {
  dependencies?: Record<string, string>;
  name?: string;
  version?: string;
};

// Each example depends on the @tsql/* packages it uses (the handlers on @tsql/rest, the query examples on
// @tsql/query), at the version in that package's package.json.
const packagesDir = new URL("packages/", root);
const versions = new Map<string, string>();
for (const dir of readdirSync(packagesDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const pkg = read(new URL(`${dir.name}/package.json`, packagesDir));
  if (pkg.name && pkg.version && !(pkg as { private?: boolean }).private) versions.set(pkg.name, pkg.version);
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fix = process.argv.includes("--fix");
const examples = new URL("examples/", root);
let failed = 0;

// examples/rest/* and examples/query/*
const names = readdirSync(examples, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .flatMap((group) =>
    readdirSync(new URL(`${group.name}/`, examples), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${group.name}/${e.name}`),
  );

for (const name of names) {
  const file = new URL(`${name}/package.json`, examples);
  const deps = read(file).dependencies ?? {};
  const used = Object.keys(deps).filter((d) => versions.has(d));
  if (used.length === 0) {
    console.error(`FAIL ${name}: it depends on none of ${[...versions.keys()].join(", ")}`);
    failed++;
  }
  for (const pkgName of used) {
    const version = versions.get(pkgName)!;
    // ^0.1.0 does not match 0.1.0-alpha.1 the way people expect, so prereleases have to be pinned exactly.
    const prerelease = version.includes("-");
    const expected = prerelease ? version : `^${version}`;
    const accepted = prerelease ? [version] : [`^${version}`, version];
    const spec = deps[pkgName]!;

    if (accepted.includes(spec)) {
      console.log(`ok   ${name}: ${pkgName} ${spec}`);
    } else if (fix) {
      // Rewrite in place rather than via JSON.stringify, to keep the file's own formatting and key order.
      const source = readFileSync(file, "utf8");
      const patched = source.replace(
        new RegExp(`("${escapeRe(pkgName)}"\\s*:\\s*)"${escapeRe(spec)}"`),
        `$1"${expected}"`,
      );
      if (patched === source) throw new Error(`could not rewrite ${pkgName} in examples/${name}/package.json`);
      writeFileSync(file, patched);
      console.log(`fixed ${name}: ${pkgName} ${spec} -> ${expected}`);
    } else {
      const why = /^(file|link|workspace):/.test(spec) ? "a local path must not be committed" : "does not match the package version";
      console.error(`FAIL ${name}: ${pkgName} is "${spec}", expected "${expected}" (${why})`);
      failed++;
    }
  }
}

if (failed) {
  console.error(`\n${failed} example(s) out of sync with the versions in packages/*/package.json.`);
  console.error("Run: bun run check:examples --fix     (to develop against the local build, use `bun run link:examples` instead of editing package.json)");
  process.exit(1);
}
