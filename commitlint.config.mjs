/**
 * Conventional commits, because release-please reads them.
 *
 * This is not a style preference: the commit messages on main are the input to
 * versioning. `feat:` moves the minor, `fix:` the patch, and a message that
 * says neither produces a release that mentions nothing and bumps nothing.
 *
 * Checked in CI on the pull request title as well as its commits, because a
 * squash merge throws the commits away and keeps the title.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // The scopes worth having, and no others — a free-for-all makes the
    // changelog harder to skim than no scopes at all.
    "scope-enum": [
      2,
      "always",
      ["install", "upgrade", "worker", "doctor", "status", "backup", "env", "ci", "deps"],
    ],
    // Long enough to say what changed, short enough to read in `git log --oneline`.
    "header-max-length": [2, "always", 72],
    "body-max-line-length": [2, "always", 100],
  },
};
