// Every examples/*/package.json must depend on the pg-rest version in the root package.json,
// the way a real project would -- never on a local path (file:/link:/workspace:), which must not be committed.
//   bun run scripts/check-example-versions.ts        (or: node scripts/check-example-versions.ts)
//   bun run scripts/check-example-versions.ts --fix  rewrites the examples to the expected spec
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (url: URL) => JSON.parse(readFileSync(url, "utf8")) as {
  dependencies?: Record<string, string>;
  version?: string;
};

const version = read(new URL("package.json", root)).version;
if (!version) throw new Error("the root package.json has no version");

// ^0.1.0 does not match 0.1.0-alpha.1 the way people expect, so prereleases have to be pinned exactly.
const prerelease = version.includes("-");
const expected = prerelease ? version : `^${version}`;
const accepted = prerelease ? [version] : [`^${version}`, version];

const fix = process.argv.includes("--fix");
const examples = new URL("examples/", root);
let failed = 0;

for (const name of readdirSync(examples, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
  const file = new URL(`${name}/package.json`, examples);
  const spec = read(file).dependencies?.["pg-rest"];

  if (spec === undefined) {
    console.error(`FAIL ${name}: pg-rest is missing from dependencies`);
    failed++;
  } else if (accepted.includes(spec)) {
    console.log(`ok   ${name}: ${spec}`);
  } else if (fix) {
    // Rewrite in place rather than via JSON.stringify, to keep the file's own formatting and key order.
    const source = readFileSync(file, "utf8");
    const patched = source.replace(
      new RegExp(`("pg-rest"\\s*:\\s*)"${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      `$1"${expected}"`,
    );
    if (patched === source) throw new Error(`could not rewrite pg-rest in examples/${name}/package.json`);
    writeFileSync(file, patched);
    console.log(`fixed ${name}: ${spec} -> ${expected}`);
  } else {
    const why = /^(file|link|workspace):/.test(spec) ? "a local path must not be committed" : "does not match the root version";
    console.error(`FAIL ${name}: pg-rest is "${spec}", expected "${expected}" (${why})`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} example(s) out of sync with the root version ${version}.`);
  console.error("Run: bun run check:examples --fix     (to develop against the local build, use `bun link pg-rest` instead of editing package.json)");
  process.exit(1);
}
