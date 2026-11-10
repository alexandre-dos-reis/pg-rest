/**
 * Rewrites the newest section of each package CHANGELOG.md from bump types into conventional ones:
 * `### Minor Changes` becomes `### Features` and `### Bug Fixes`, the way a reader thinks about a
 * release.
 *
 * It is a post-processing step and not a `changelog` module because the headings are not pluggable:
 * `@changesets/apply-release-plan` builds them as `### ${capitalize(type)} Changes`, and the only
 * hook changesets offers -- `getReleaseLine` -- formats a bullet, not the heading above it. So
 * `bun run version` lets changesets write the file and then regroups what it wrote.
 *
 * The type comes from the changeset summary, which `scripts/check-changesets.ts` requires to start
 * with one: `feat: ...`, `fix(query): ...`. The prefix is stripped from the bullet, since the
 * heading now carries it. A bullet with no prefix -- an older changeset, or a dependency bump
 * changesets wrote itself -- keeps its place under "Other Changes" rather than being guessed at.
 *
 *   bun run scripts/changelog-sections.ts [--check] [paths...]
 *
 * `--check` reports what it would change and exits non-zero, for CI.
 */

/** Conventional type -> heading, in the order a release note should read. */
const SECTIONS: ReadonlyArray<readonly [heading: string, types: readonly string[]]> = [
  ["Breaking Changes", []], // by the `!` marker, not a type
  ["Features", ["feat"]],
  ["Bug Fixes", ["fix"]],
  ["Performance", ["perf"]],
  ["Documentation", ["docs"]],
  ["Internal", ["refactor", "chore", "ci", "test", "build", "style", "example", "rename"]],
  ["Other Changes", []], // no recognisable prefix
];

const HEADING_OF = new Map<string, string>(
  SECTIONS.flatMap(([heading, types]) => types.map((t) => [t, heading] as const)),
);

/** `- 0c32d76: feat(query): a thing` -> the type, the `!`, and the bullet without its prefix. */
const PREFIX = /^(-\s+)(?:([0-9a-f]{7,40}):\s+)?([a-z]+)(\([a-z0-9,/-]+\))?(!)?:\s+/;

interface Bullet {
  heading: string;
  text: string;
  /** Whether a conventional type was actually found, as opposed to the bullet being filed by default. */
  classified: boolean;
}

/**
 * Splits a rendered section body into bullets: a bullet owns every line that follows it until the
 * next one. Only an *unindented* `- ` starts a bullet -- a changeset summary carries nested lists
 * and fenced code of its own, and an indented `- ` inside one is part of the bullet above, not a
 * new entry.
 */
const splitBullets = (body: string): string[] => {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (/^-\s+/.test(line) || out.length === 0) out.push(line);
    else out[out.length - 1] += `\n${line}`;
  }
  return out.filter((b) => b.trim());
};

const classify = (bullet: string, bumpHeading: string): Bullet => {
  const m = PREFIX.exec(bullet);
  if (!m) {
    const heading = bumpHeading === "Major Changes" ? "Breaking Changes" : "Other Changes";
    return { heading, text: bullet, classified: false };
  }
  const [, dash, hash, type, , bang] = m;
  // A `!` is breaking whatever the type says, and a major bump is breaking even without one.
  const heading = bang || bumpHeading === "Major Changes"
    ? "Breaking Changes"
    : HEADING_OF.get(type!) ?? "Other Changes";
  // The hash is kept: it is the only link from a line back to the commit that explained it.
  const rest = bullet.slice(m[0].length);
  return { heading, text: `${dash}${hash ? `${hash}: ` : ""}${rest}`, classified: true };
};

/** The newest `## x.y.z` block, which is the one `changeset version` just wrote. */
const newestSection = (text: string): { start: number; end: number } | undefined => {
  const first = text.search(/^## /m);
  if (first < 0) return undefined;
  const after = text.slice(first + 1).search(/^## /m);
  return { start: first, end: after < 0 ? text.length : first + 1 + after };
};

const regroup = (section: string): string => {
  const lines = section.split("\n");
  const version = lines[0]!; // `## 0.2.0`
  const bullets: Bullet[] = [];
  let bumpHeading = "";
  let buffer: string[] = [];

  const flush = () => {
    if (!bumpHeading) return;
    for (const b of splitBullets(buffer.join("\n"))) bullets.push(classify(b, bumpHeading));
    buffer = [];
  };

  for (const line of lines.slice(1)) {
    const m = /^### (Major|Minor|Patch) Changes\s*$/.exec(line);
    if (m) {
      flush();
      bumpHeading = `${m[1]} Changes`;
      continue;
    }
    if (/^### /.test(line)) {
      // Already regrouped (or a heading this script does not own): leave the section alone.
      return section;
    }
    buffer.push(line);
  }
  flush();

  if (!bullets.length) return section;

  // Nothing here declares a type, so every bullet would land under "Other Changes" and the section
  // would be renamed for no gain. That is what an already-published section looks like -- written
  // before the convention -- so it is left exactly as it is.
  if (!bullets.some((b) => b.classified)) return section;

  const out = [version, ""];
  for (const [heading] of SECTIONS) {
    const mine = bullets.filter((b) => b.heading === heading);
    if (!mine.length) continue;
    out.push(`### ${heading}`, "");
    for (const b of mine) out.push(b.text.trimEnd(), "");
  }
  // Two trailing newlines: the section that follows needs a blank line before its `## x.y.z`.
  return `${out.join("\n").trimEnd()}\n\n`;
};

const args = process.argv.slice(2);
const check = args.includes("--check");
const paths = args.filter((a) => !a.startsWith("--"));
const files = paths.length ? paths : ["packages/query/CHANGELOG.md", "packages/rest/CHANGELOG.md"];

let changed = 0;
for (const file of files) {
  const f = Bun.file(file);
  if (!(await f.exists())) continue;
  const text = await f.text();
  const at = newestSection(text);
  if (!at) continue;
  const before = text.slice(at.start, at.end);
  const after = regroup(before);
  if (before === after) continue;
  changed++;
  if (check) console.log(`would regroup ${file}`);
  else {
    await Bun.write(file, text.slice(0, at.start) + after + text.slice(at.end));
    console.log(`regrouped ${file}`);
  }
}

if (!changed) console.log("changelogs already read as conventional sections");
if (check && changed) process.exit(1);

export {}; // a module, so top-level await is allowed outside the typechecked include
