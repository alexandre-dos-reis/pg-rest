import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import type * as TS from "typescript";

/**
 * Compiles every TypeScript block of `docs/*.md` against the fixture's generated types, which are
 * the schema those docs describe. An example that drifts from the API fails here rather than in
 * someone's editor; the blocks that are meant to be refused carry `@ts-expect-error`, so a mistake
 * that stops being one is caught too.
 */
const ts = createRequire(import.meta.url)("typescript") as typeof TS;

const root = new URL("..", import.meta.url).pathname;
const file = `${root}tests/_docs.ts`;

/** The preamble the blocks are written against: a typed instance, and the names they mention. */
const PREAMBLE = `
import { createPgRest, QueryError } from "../src/index";
import type { DbAdapter } from "../src/adapter";
import type { DatabasePgRest } from "./support/fixture.types";

type Database = DatabasePgRest;
declare const pool: unknown;
declare const nodePostgresAdapter: (p: unknown) => DbAdapter;
declare const pgRest: Awaited<ReturnType<typeof createPgRest<Database>>>;
declare const ctx: { role: string; claims: { sub: string; email: string } };
declare const user: { id: string; email: string };
void [createPgRest, QueryError, pool, nodePostgresAdapter, pgRest, ctx, user];
`;

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

describe("the examples in the documentation", () => {
  test("docs/query.md compiles", () => {
    const markdown = readFileSync(`${root}docs/query.md`, "utf8");
    const blocks = blocksOf(markdown);
    expect(blocks.length).toBeGreaterThan(20);
    // each block in its own scope: they redeclare the same names, and most of them await
    const content = `${PREAMBLE}\n${blocks.map((b, i) => `export const block${i} = async () => {\n${b}\n};`).join("\n\n")}`;
    const errors = diagnose(content);
    if (errors.length) console.error(`\n${errors.join("\n")}\n`);
    expect(errors).toEqual([]);
  });
});
