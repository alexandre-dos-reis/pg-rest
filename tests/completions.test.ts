import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

/**
 * What an editor offers inside a typed query, asked of the TypeScript language service itself.
 *
 * This is not a detail of taste: TypeScript only narrows the contextual type of a nested property
 * (the items of `select`, the keys of `where`) when the discriminant picks **exactly one** member of
 * the union. Two things are needed for that, and both are easy to undo by accident --
 * `src/typed.ts` must keep one member per table (reads and writes merged, their payloads enforced
 * by `WriteRules`) and every member must *declare* `table`, the function calls included (`table?:
 * never`). Without them the editor proposes every table's columns, which is what this pins.
 */
import type * as TS from "typescript";

const ts = createRequire(import.meta.url)("typescript") as typeof TS;

const dir = new URL(".", import.meta.url).pathname;
const file = `${dir}_completions.ts`;

/** Completion entries at `#` in `snippet`, with the marker removed. */
const completionsAt = (snippet: string): string[] => {
  const marked = `
import { createPgRest } from "../src/index";
import type { DatabasePgRest } from "./support/fixture.types";
declare const pgRest: Awaited<ReturnType<typeof createPgRest<DatabasePgRest>>>;
${snippet}
`;
  const pos = marked.indexOf("#");
  if (pos < 0) throw new Error("the snippet needs a # marker");
  const content = marked.slice(0, pos) + marked.slice(pos + 1);

  const options: TS.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  };
  const host: TS.LanguageServiceHost = {
    getScriptFileNames: () => [file],
    getScriptVersion: () => "1",
    getScriptSnapshot: (f: string) =>
      f === file
        ? ts.ScriptSnapshot.fromString(content)
        : existsSync(f)
          ? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8"))
          : undefined,
    getCurrentDirectory: () => dir,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o: TS.CompilerOptions) => ts.getDefaultLibFilePath(o),
    fileExists: (f: string) => f === file || ts.sys.fileExists(f),
    readFile: (f: string) => (f === file ? content : ts.sys.readFile(f)),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return (service.getCompletionsAtPosition(file, pos, {})?.entries ?? []).map((e) => e.name).sort();
};

describe("what an editor offers in a typed query", () => {
  test("the table restricts the columns of select", () => {
    expect(completionsAt(`void pgRest.query({ table: "profiles", select: ["#"] });`)).toEqual([
      "*",
      "bio",
      "client_id",
    ]);
    // not the columns of every other table
    expect(completionsAt(`void pgRest.query({ table: "profiles", select: ["#"] });`)).not.toContain("placed_at");
  });

  test("... and the keys of where, with and/or alongside them", () => {
    expect(completionsAt(`void pgRest.query({ table: "profiles", where: { # } });`)).toEqual([
      "and",
      "bio",
      "client_id",
      "or",
    ]);
  });

  test("... and the embeddable relationships", () => {
    const items = completionsAt(`void pgRest.query({ table: "profiles", select: [{ # }] });`);
    // profiles(client_id) -> clients, and what clients leads back to
    expect(items).toContain("clients");
    expect(items).toContain("client_id");
    expect(items).not.toContain("order_items");
  });

  test("a function that returns a table's rows offers that table's columns", () => {
    expect(completionsAt(`void pgRest.query({ rpc: "orders_by_status", select: ["#"] });`)).toEqual([
      "*",
      "client_id",
      "id",
      "placed_at",
      "status",
      "total",
    ]);
    expect(completionsAt(`void pgRest.query({ rpc: "#" });`)).toContain("orders_by_status");
    // a TABLE(...) function is the known gap: the catalog does not carry its output columns, so
    // there is nothing to offer and any name is accepted (the request path knows no more)
    expect(completionsAt(`void pgRest.query({ rpc: "client_summary", select: ["#"] });`)).toEqual([""]);
  });

  test("the table names are the exposed ones", () => {
    const tables = completionsAt(`void pgRest.query({ table: "#" });`);
    expect(tables).toContain("clients");
    expect(tables).toContain("profiles");
    // v2.things lives in another schema, which has to be named first
    expect(tables).not.toContain("things");
    expect(completionsAt(`void pgRest.query({ schema: "v2", table: "#" });`)).toEqual(["things"]);
  });
});
