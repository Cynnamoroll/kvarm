# oxlint quality gate — setup report

**Status: complete. Gate is green (typecheck + test + lint all exit 0).**
Date: setup performed in this session. Repo: `<repo-root>` (branch `main`).
Nothing was committed, deployed, or served. No files touched in `apps/platform/wrangler*.jsonc`.

## 1. oxlint version

| Item | Value |
| --- | --- |
| Package | `oxlint` |
| Installed version | **1.87.0** (exact-pinned, `"oxlint": "1.87.0"`) |
| Install command used | `npm install -D --save-exact oxlint` (from `<repo-root>`) |
| Location | root `devDependencies` in `<repo-root>/package.json` |
| Binary | `node_modules/.bin/oxlint` |

Also verified: **no pre-existing lint tooling** existed in the repo. No `eslint.config.*`,
`.eslintrc*`, `biome.json`, `prettier` config, and no `"lint"` script in any
`package.json` (root, `apps/platform`, or `packages/*`). So there was **no tool conflict** and
the `lint` script name was free.

## 2. Pre-existing scripts (names NOT renamed, used as-is by the gate)

From root `package.json`:

- `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p apps/platform/tsconfig.json --noEmit"`
- `"test": "vitest run"`
- `"test:watch": "vitest"` (untouched)
- `"dev"`, `"deploy"` (untouched)

Root `vitest.config.ts` includes `packages/**/test/**/*.test.ts`, environment `node`.
There are no test files and no vitest config under `apps/`, so the root `npm run test`
covers every test that currently exists in the repo (27 tests / 4 files).

## 3. Config file: `<repo-root>/.oxlintrc.json`

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "categories": {
    "correctness": "error"
  },
  "ignorePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "**/.wrangler/**",
    "**/.output/**",
    "**/build/**"
  ]
}
```

### Rules / categories disabled

**No lint rules were disabled.** The final config disables zero rules.

`"correctness": "error"` is oxlint's own default category setting (see `oxlint --help`:
"`correctness` - Code that is outright wrong or useless (default)"). Stating it explicitly
makes the gate's intent self-documenting without changing behavior. Default plugins
(`unicorn`, `oxc`, `typescript` — all on by default per `oxlint --help`) are left at their
defaults; the `plugins` key is omitted on purpose so the documented default set applies.

`ignorePatterns` mirrors the repo's `.gitignore` build-output set so generated artifacts are
never linted. These are belt-and-braces: oxlint already skips `node_modules` and dot-directories
(verified with `--debug=files` — it lints 36 files and skips `apps/platform/.wrangler/`), and no
`dist/`, `coverage/`, `build/` dirs exist yet. `apps/platform/worker-configuration.d.ts` (generated
by `wrangler types`, git-tracked) is intentionally left in scope; it currently lints clean.

### Rules considered and deliberately NOT enabled (with evidence)

Both of these were measured against the current codebase before being rejected, because all
hits are refactor-class smells rather than defects — exactly the "fixes would be refactors"
class the task says to tune out rather than chase:

- `suspicious` category (`-D suspicious`): **+10 errors** on current code —
  4× `unicorn/no-array-sort` (`sort()` vs `toSorted()`), 4× `unicorn/consistent-function-scoping`
  (helpers `blob`/`blobHash`/`file`/`dir` don't close over parent scope), 1×
  `eslint(no-useless-constructor)`, 1× `unicorn(require-module-specifiers)`.
- `perf` category (`-D perf`): **+11 errors** — 10× `eslint(no-await-in-loop)` (intentional
  sequential awaits) and 1× `unicorn(prefer-set-has)`.
- For reference, `-D all` produces 2211 errors, i.e. style/restriction noise, not a usable gate.
- Optional plugins also measured: `--import-plugin` adds **0** violations; `--vitest-plugin`
  adds 1 warning (`vitest/no-conditional-expect` in a test). Neither was enabled, to keep the
  gate "default correctness-focused" as specified. (`--import-plugin` is verified clean and is
  the one optional strengthening a future agent could add safely.)

The single violation oxlint reported out of the box was a **warning**, not an error:
`eslint(no-unused-vars)` on an unused function parameter. Rather than disable a genuinely useful
correctness rule globally, that one real (if trivial) defect was fixed — see below.

## 4. Source edits

Total source edits: **1 file, 1 line (a one-token rename)**.

`apps/platform/src/routes/repoPages.ts:91`

```diff
-function notFound(c: Context<App>): Response {
+function notFound(_c: Context<App>): Response {
   return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
 }
```

Rationale: the `c` parameter was genuinely unused in the body (the function returns a static 404
`Response` and never reads the Hono context). oxlint's own suggested remedy is the `_` prefix
convention ("Unused parameters should start with a '_'"). The rename is behavior-neutral — the
parameter is passed positionally at all 19 call sites (`notFound(c)`), none of which needed to
change, and the parameter name has no effect on the function's type. This was preferred over
setting `no-unused-vars` to `args: "none"`, which would have weakened the rule repo-wide for a
single occurrence. Confirmed by typecheck (exit 0) and the full test suite (27/27 pass) after the edit.

Other file changes (not source code):

- `package.json` — added `"lint": "oxlint ."` to `scripts` and `"oxlint": "1.87.0"` to `devDependencies`.
- `.oxlintrc.json` — new file.
- `package-lock.json` — updated by the oxlint install.

## 5. Gate command strings for the mission manifest

Run from the repo root `<repo-root>`, in this order:

| # | Command | Tool |
| --- | --- | --- |
| 1 | `npm run typecheck` | `tsc -p tsconfig.json --noEmit && tsc -p apps/platform/tsconfig.json --noEmit` |
| 2 | `npm run test` | `vitest run` |
| 3 | `npm run lint` | `oxlint .` |

All three are the repo's real script names as they exist in root `package.json`; none were renamed.
`npx oxlint .` is equivalent to `npm run lint` if the manifest prefers invoking the binary directly.

## 6. Gate results (run in order, after all changes)

| # | Command | Exit code | Output tail |
| --- | --- | --- | --- |
| 1 | `npm run typecheck` | **0** | clean; both `tsc --noEmit` passes emit no diagnostics |
| 2 | `npm run test` | **0** | `Test Files 4 passed (4)` / `Tests 27 passed (27)` / `Duration 3.68s` |
| 3 | `npm run lint` | **0** | `Found 0 warnings and 0 errors.` / `Finished in 80ms on 36 files with 96 rules using 6 threads.` |

Baseline before the setup (for comparison): typecheck already exited 0 and
`npx vitest run` already reported 27/27 passing, so **nothing was broken before these changes**;
the only thing missing was the lint leg. Raw `npx oxlint .` with no config at all was already
`Found 1 warning and 0 errors` (exit 0); after the one-line fix the gate output is fully clean.

## 7. Findings

1. **Gate is fully green and warning-free** — 0 errors *and* 0 warnings on 36 files / 96 rules.
   No rules needed disabling.
2. **`apps/platform/package.json` left exactly as the prior agent had it** (verified via
   `git diff`): `@modelcontextprotocol/sdk: ^1.32.1` added and `@cloudflare/vitest-pool-workers`
   at `^0.23.0`, still uncommitted. Untouched by this task.
3. **`package-lock.json` carries a large diff** (+1742/−184). It was already modified before this
   task began (prior agent's dependency work); this task added only oxlint itself (2 packages).
   Do not "clean up" that lockfile diff without accounting for the prior agent's changes.
4. **Root `npm run test` is the only test entry point that matters today**: root
   `vitest.config.ts` includes `packages/**/test/**/*.test.ts`, and there are zero test files and
   no vitest config under `apps/`. `apps/platform`'s own `"test": "vitest run"` script currently
   would run no tests. If app-level tests are added later under `apps/**`, the root gate will not
   pick them up until `vitest.config.ts` is widened (e.g. `apps/**/test/**/*.test.ts`) — worth
   deciding at that time, not now.
5. **`npm install` reported 5 high-severity vulnerabilities** in the existing dependency tree
   (pre-existing, unrelated to oxlint; `npm audit fix --force` would make breaking changes).
   Left alone per constraints — flagging only so it is not mistaken for something this task introduced.
6. **Optional future strengthening**: `--import-plugin` was verified to add zero violations on the
   current code and would catch ESM resolution breakage; enabling it is a safe, optional next step.
   `--vitest-plugin` would require addressing 1 `no-conditional-expect` warning in a test file.
7. Nothing was committed, deployed, or started; `apps/platform/wrangler*.jsonc` was not touched.
