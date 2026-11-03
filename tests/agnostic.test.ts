import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/** The library must not depend on any runtime or driver: callers pass an adapter. */
describe("runtime-agnostic library", () => {
  test("src/ does not reference Bun, node: builtins or a database driver", async () => {
    const offenders: string[] = [];
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      const text = (await Bun.file(file).text()).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // ignore comments
      if (/from\s+["'](bun|bun:[^"']*|node:[^"']*|pg|postgres|@electric-sql\/pglite)["']|\bBun\.|\bprocess\.|require\(|import\(["']bun/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
