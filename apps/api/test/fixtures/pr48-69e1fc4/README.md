Exact sources of PR #48 at head 69e1fc4 (base main 94e0679), used by the offline replays of
live reviews #5 and #6 (`src/ai/pr-review/pr-review-flow.spec.ts`,
`src/ai/pr-review/pr-review-refutation.spec.ts`).

- `<path>.patch`: `git diff origin/main...69e1fc4 -- <path>` (candidate files and changed
  files whose call sites are searched for callers)
- `<path>.head`: the file at 69e1fc4 (candidate files, plus the files the dependency
  resolver reads at the head: helpers, tsconfig/package.json, shared package barrels)

Path separators are replaced by `_` in file names. Test data only (excluded from the build).
