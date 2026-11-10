/**
 * Conventional commits, by commitlint rather than by hand. `.mjs` and not `.ts`: a TypeScript config
 * needs a loader commitlint does not depend on, and this file has nothing in it worth types.
 *
 * Enforced in two places, for two different gaps:
 *   scripts/githooks/commit-msg   as the message is written, where it is free to fix
 *   .github/workflows/ci.yml      over a pull request's whole range, which catches what the hook
 *                                 never saw -- a commit made in the GitHub UI, or one pushed with
 *                                 --no-verify
 */

/** @type {import("@commitlint/types").UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // config-conventional's list, plus the three this history has earned:
    //   example  a change to examples/ alone
    //   release  what `bun run version` commits
    //   rename   a rename that is neither a refactor nor a feature (the `tspg` move was one)
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "docs",
        "example",
        "feat",
        "fix",
        "perf",
        "refactor",
        "release",
        "rename",
        "revert",
        "style",
        "test",
      ],
    ],
    // 72, which is p90 of the last 200 subjects here (median 57); conventional's default is 100.
    // A longer thought belongs in the body, where it wraps and `git log --oneline` does not cut it.
    "header-max-length": [2, "always", 72],
    // The body is prose, and these suites' paths and SQL snippets run long; wrapping is not policed.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
