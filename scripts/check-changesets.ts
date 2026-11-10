/**
 * Every changeset summary has to start with a conventional type, the same way a commit subject does
 * (`scripts/githooks/commit-msg`):
 *
 *   ---
 *   "@tspg/query": minor
 *   ---
 *
 *   feat(query): accept a JSON path in a typed where
 *
 * Not for its own sake: `scripts/changelog-sections.ts` groups the released notes by that type, so a
 * changeset without one lands under "Other Changes" and the release reads worse for it.
 *
 * It also catches the mistake that has actually bitten this repo: a changeset naming a package that
 * is not in the workspace. One naming `@adrdp/pg-rest` survived the split and the rename, and
 * `changeset version` refused to run at all until it was fixed -- during a release, which is the
 * worst moment to find out.
 *
 *   bun run scripts/check-changesets.ts
 */

const TYPES = [
  "feat",
  "fix",
  "docs",
  "refactor",
  "chore",
  "ci",
  "test",
  "perf",
  "build",
  "example",
  "rename",
  "style",
];

const SUMMARY = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9,/-]+\\))?!?:\\s+\\S`);

const workspaces = new Set<string>();
/**
 * A private package has no release of its own -- it is bundled into the published ones -- so
 * changesets ignores it, and refuses a changeset that names an ignored package beside a published
 * one ("Found mixed changeset"). `@tspg/core` in a changeset is the mistake that looks most
 * reasonable, which is why it is checked here and not only by `changeset status` in CI.
 */
const ignored = new Set<string>();
for (const dir of ["core", "adapters", "query", "rest"]) {
  const pkg = Bun.file(`packages/${dir}/package.json`);
  if (!(await pkg.exists())) continue;
  const { name, private: isPrivate } = await pkg.json();
  if (isPrivate) ignored.add(name);
  else workspaces.add(name);
}

const glob = new Bun.Glob(".changeset/*.md");
const problems: string[] = [];
let checked = 0;

for await (const path of glob.scan(".")) {
  if (path.endsWith("README.md")) continue;
  checked++;
  const text = await Bun.file(path).text();

  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) {
    problems.push(`${path}: no frontmatter block`);
    continue;
  }
  const [, frontmatter, body] = m;

  for (const line of frontmatter!.split("\n")) {
    const named = /^\s*"?([^":]+)"?\s*:\s*(major|minor|patch)\s*$/.exec(line);
    if (!line.trim()) continue;
    if (!named) {
      problems.push(`${path}: cannot read "${line.trim()}" as \`"<package>": <major|minor|patch>\``);
      continue;
    }
    if (ignored.has(named[1]!)) {
      problems.push(
        `${path}: "${named[1]}" is private, so changesets ignores it and refuses the changeset.\n` +
          `    Name the published package the change ships in instead: ${[...workspaces].sort().join(", ")}`,
      );
    } else if (!workspaces.has(named[1]!)) {
      problems.push(
        `${path}: "${named[1]}" is not a published workspace (have: ${[...workspaces].sort().join(", ")})`,
      );
    }
  }

  const summary = body!.trim();
  if (!summary) problems.push(`${path}: the summary is empty`);
  else if (!SUMMARY.test(summary)) {
    problems.push(
      `${path}: the summary starts "${summary.split("\n")[0]!.slice(0, 48)}…"\n` +
        `    expected a type first: ${TYPES.join(", ")}`,
    );
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s) in ${checked} changeset(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`ok   ${checked} changeset(s)`);

export {}; // a module, so top-level await is allowed outside the typechecked include
