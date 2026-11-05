import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type * as TS from "typescript";

/**
 * Compiles every TypeScript block of the README and `docs/*.md` against the fixture's generated
 * types, which are the schema those docs describe. An example that drifts from the API fails here
 * rather than in someone's editor; the blocks that are meant to be refused carry
 * `@ts-expect-error`, so a mistake that stops being one is caught too. A block that cannot compile
 * -- an excerpt of a generated type, an interface quoted for illustration -- is fenced ```ts ignore.
 *
 * Then: every relative link in those files has to point at something that exists.
 */
const ts = createRequire(import.meta.url)("typescript") as typeof TS;

const root = new URL("..", import.meta.url).pathname;
const file = `${root}tests/_docs.ts`;

/**
 * The preamble the blocks are written against: a typed instance over the schema the page documents,
 * and the names its examples mention. The README's examples are the todo schema of
 * `examples/with-generated-types`, which ships its generated types; everything in `docs/` is
 * written against the test fixture.
 */
const preamble = (dbTypes: string) => `
import { createPgRest, QueryError } from "../src/index";
import type { DbAdapter } from "../src/adapter";
import type { DatabasePgRest } from "${dbTypes}";

type Database = DatabasePgRest;
declare const pool: unknown;
declare const nodePostgresAdapter: (p: unknown) => DbAdapter;
declare const pgRest: Awaited<ReturnType<typeof createPgRest<Database>>>;
declare const ctx: { role: string; claims: { sub: string; email: string } };
declare const user: { id: string; email: string };
declare const mySessionLookup: (req: Request) => Promise<{ id: string; email: string } | undefined>;
declare const pg: { Pool: new (config: { connectionString?: string }) => unknown };
declare const writeFileSync: (path: string, data: string) => void;
declare const generateTypes: (cache: unknown, options?: { name?: string }) => string;
void [createPgRest, QueryError, pool, nodePostgresAdapter, pgRest, ctx, user];
void [mySessionLookup, pg, writeFileSync, generateTypes];
`;

const DB_TYPES_OF = (page: string) =>
  page === "README.md" ? "../examples/with-generated-types/db.types" : "./support/fixture.types";

/** ```ts fenced blocks, minus their import lines (the preamble has those). */
const blocksOf = (markdown: string): string[] => {
  const out: string[] = [];
  const re = /^```ts(.*)\n([\s\S]*?)^```$/gm;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
    if (m[1]!.includes("ignore")) continue;
    out.push(
      m[2]!
        .split("\n")
        .filter((l) => !l.startsWith("import "))
        .join("\n"),
    );
  }
  return out;
};

const diagnose = (content: string): string[] => {
  const options: TS.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    // a documentation example is allowed to name something and not use it
    noUnusedLocals: false,
  };
  const host = ts.createCompilerHost(options, true);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) =>
    name === file ? ts.createSourceFile(name, content, ts.ScriptTarget.ESNext, true) : original(name, ...rest);
  host.fileExists = (f) => f === file || existsSync(f);
  host.readFile = (f) => (f === file ? content : existsSync(f) ? readFileSync(f, "utf8") : undefined);
  const program = ts.createProgram([file], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === file)
    .map((d) => {
      const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
      const source = content.split("\n")[line - 1]?.trim() ?? "";
      return `line ${line}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}\n    ${source}`;
    });
};

/** The markdown that documents the library: the README, and everything in docs/. */
const pages = [
  "README.md",
  ...readdirSync(`${root}docs`)
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
];

describe("the documentation", () => {
  test("the pages are the ones the README links to", () => {
    expect(pages.length).toBeGreaterThan(8);
    const readme = readFileSync(`${root}README.md`, "utf8");
    for (const page of pages.filter((p) => p !== "README.md")) {
      expect(readme).toContain(`(${page})`);
    }
  });

  for (const page of pages) {
    test(`${page} compiles`, () => {
      const blocks = blocksOf(readFileSync(`${root}${page}`, "utf8"));
      if (blocks.length === 0) return;
      // each block in its own scope: they redeclare the same names, and most of them await
      const content = `${preamble(DB_TYPES_OF(page))}\n${blocks
        .map((b, i) => `export const block${i} = async () => {\n${b}\n};`)
        .join("\n\n")}`;
      const errors = diagnose(content);
      if (errors.length) console.error(`\n${page}\n${errors.join("\n")}\n`);
      expect(errors).toEqual([]);
    });
  }

  test("every relative link points at something that exists", () => {
    const broken: string[] = [];
    for (const page of [
      ...pages,
      ...readdirSync(`${root}examples`).map((d) => `examples/${d}/README.md`),
      "PARITY.md",
      "AGENTS.md",
    ]) {
      if (!existsSync(`${root}${page}`)) continue;
      const dir = `${root}${page}`.replace(/[^/]+$/, "");
      for (const [, target] of readFileSync(`${root}${page}`, "utf8").matchAll(/\]\(([^)#:]+)(?:#[^)]*)?\)/g)) {
        if (target === undefined || target.startsWith("http")) continue;
        if (!existsSync(`${dir}${target}`)) broken.push(`${page} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
