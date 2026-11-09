import { API, type Diagnostic, type Project, type Snapshot } from "typescript/async";
import { createFileSystemLayer } from "typescript/fs";

/**
 * A TypeScript project over sources that only exist in memory.
 *
 * TypeScript 7 ships no compiler this process can call: the `typescript` package exports a version,
 * and the compiler is a native binary driven over `typescript/async`. That API is tsconfig-driven
 * -- a project, not a list of files and options -- and reads what it compiles from the filesystem,
 * so the generated sources and the config naming them are a *filesystem layer* on the snapshot:
 * what the layer holds shadows the real filesystem, and everything else falls through to it (the
 * packages' sources, the fixture's types, `lib.d.ts`).
 *
 * Every call is a round trip to that binary, so both callers ask one project as few times as they
 * can: `tests/docs.test.ts` compiles every page in one project, `packages/query/tests/completions.test.ts` keeps
 * one project and swaps the file's content.
 */
export interface VirtualProject {
  /** The project over the sources as they are now. The previous snapshot is dropped. */
  readonly load: () => Promise<Project>;
  /** Replace a source's content, then `load`. */
  readonly update: (fileName: string, content: string) => Promise<Project>;
  /** Stop the compiler process. */
  readonly dispose: () => Promise<void>;
}

/** What both callers compile with: the root `tsconfig.json`'s settings, minus its strictest ones. */
const COMPILER_OPTIONS = {
  target: "esnext",
  lib: ["es2023"],
  module: "preserve",
  moduleResolution: "bundler",
  moduleDetection: "force",
  // `Request`/`Response`, which the examples mount a handler in
  types: ["bun"],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
};

export const virtualProject = (options: {
  /** The repository root: what the compiler resolves relative paths against. */
  readonly root: string;
  /** Absolute path of the virtual `tsconfig.json`. Its directory is where the sources resolve from. */
  readonly configFileName: string;
  /** The project's root files, by absolute path. */
  readonly sources: ReadonlyMap<string, string>;
  readonly compilerOptions?: Readonly<Record<string, unknown>>;
}): VirtualProject => {
  const { root, configFileName, sources, compilerOptions } = options;
  const files = new Map(sources);
  files.set(
    configFileName,
    JSON.stringify({
      compilerOptions: { ...COMPILER_OPTIONS, ...compilerOptions },
      files: [...sources.keys()],
    }),
  );

  const api = new API({ cwd: root });
  let changed: string[] = [];
  let current: Snapshot | undefined;

  const load = async (): Promise<Project> => {
    const snapshot = await api.createSnapshot({
      fileSystem: createFileSystemLayer([...files]),
      openProjects: [configFileName],
      ...(changed.length ? { fileNotifications: { changed } } : {}),
    });
    // the previous one, and the project read from it, are done with
    await current?.dispose();
    current = snapshot;
    changed = [];
    const project = snapshot.getConfiguredProject(configFileName);
    if (project === undefined) throw new Error(`no project for ${configFileName}`);
    return project;
  };

  return {
    load,
    update: (fileName, content) => {
      files.set(fileName, content);
      changed = [fileName];
      return load();
    },
    dispose: async () => {
      try {
        await api.close();
      } catch {
        // closing rejects whatever is still in flight, which is the point of closing
      }
    },
  };
};

/** A diagnostic's message, with the chained ones a `Type 'x' is not assignable to` carries. */
export const messageOf = (diagnostic: Diagnostic): string =>
  [diagnostic.text, ...(diagnostic.messageChain ?? []).map(messageOf)].join(" ");
