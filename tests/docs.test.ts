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
// the hosts the README mounts the handler in
declare const serve: (options: { fetch: (req: Request) => Promise<Response>; port?: number }) => unknown;
declare const app: { all: (path: string, handler: (c: { req: { raw: Request } }) => Promise<Response>) => void };
declare const generateTypes: (cache: unknown, options?: { name?: string }) => string;
void [createPgRest, QueryError, pool, nodePostgresAdapter, pgRest, ctx, user];
void [mySessionLookup, pg, writeFileSync, generateTypes, serve, app];
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

/**
 * Every page in one program, rather than one program per page: each becomes its own virtual file,
 * compiled together, and the diagnostics are handed back per page. Ten programs meant reading
 * lib.d.ts ten times.
 */
const diagnoseAll = (sources: Map<string, string>): Map<string, string[]> => {
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
  /** One file per page, named after it so a diagnostic says which page it came from. */
  const fileOf = (page: string) => `${root}tests/_docs_${page.replace(/[^a-z]/gi, "_")}.ts`;
  const contents = new Map([...sources].map(([page, text]) => [fileOf(page), text]));

  const host = ts.createCompilerHost(options, true);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) => {
    const text = contents.get(name);
    return text === undefined ? original(name, ...rest) : ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true);
  };
  host.fileExists = (f) => contents.has(f) || existsSync(f);
  host.readFile = (f) => contents.get(f) ?? (existsSync(f) ? readFileSync(f, "utf8") : undefined);
  const program = ts.createProgram([...contents.keys()], options, host);

  const out = new Map([...sources.keys()].map((page) => [page, [] as string[]]));
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const name = d.file?.fileName;
    if (name === undefined || !contents.has(name)) continue;
    const page = [...sources.keys()].find((p) => fileOf(p) === name)!;
    const line = d.start !== undefined ? d.file!.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    const source = contents.get(name)!.split("\n")[line - 1]?.trim() ?? "";
    out.get(page)!.push(`line ${line}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}\n    ${source}`);
  }
  return out;
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

  /** Compiled once for every page, on first use. */
  let compiled: Map<string, string[]> | undefined;
  const errorsOf = (page: string) => {
    compiled ??= diagnoseAll(
      new Map(
        pages.map((p) => {
          const blocks = blocksOf(readFileSync(`${root}${p}`, "utf8"));
          // each block in its own scope: they redeclare the same names, and most of them await
          return [
            p,
            `${preamble(DB_TYPES_OF(p))}\n${blocks
              .map((b, i) => `export const block${i} = async () => {\n${b}\n};`)
              .join("\n\n")}`,
          ];
        }),
      ),
    );
    return compiled.get(page) ?? [];
  };

  for (const page of pages) {
    test(`${page} compiles`, () => {
      const errors = errorsOf(page);
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
