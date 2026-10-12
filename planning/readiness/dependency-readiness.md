# Mission Dependency Readiness — Forge

Verification run: 2026-10-07 21:05 UTC. All checks were executed against live resources (not inferred from configs). Scratch verification project: `/tmp/forge-dep-check` (kept for reference; contains the workerd smoke tests).

## Verified

| # | Item | Command run | Result |
|---|------|-------------|--------|
| 1 | wrangler CLI | `. "$HOME/.config/vite-plus/env"; wrangler --version; wrangler whoami` | **4.148.0**; OAuth-logged-in as `<owner-email>`; account `<account-id>` (matches expected); token scopes include `artifacts (write)`, `d1 (write)`, `queues (write)`, `workers (write)` |
| 2a | Live worker health | `curl -s -o /dev/null -w '%{http_code}' https://forge-platform.<subdomain>.workers.dev/healthz` | **200** |
| 2b | Repo tree page | `curl -s -o /dev/null -w '%{http_code}' https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e` | **200** |
| 3 | Remote D1 | `cd apps/platform && wrangler d1 execute forge --remote --command "SELECT COUNT(*) ... FROM users; ... repos; ... pat" -c wrangler.jsonc` | **users=1, repos=1, pats=1** (DB `forge`, id `<database-id>`, v3-prod, WNAM/SEA) |
| 4 | R2 | `wrangler r2 bucket list` | **forge-snapshots** exists (created 2026-10-07T20:53:14.970Z) |
| 5 | Queues | `wrangler queues list` | **forge-events** (id `<queue-id>`, 1 producer / 1 consumer) and **forge-events-dlq** (id `<dlq-id>`, 0/0) |
| 6 | Artifacts repo | `wrangler artifacts repos get <owner>--forge-e2e --namespace default` | exists; id `<artifacts-repo-id>`; **default_branch: main**; remote `https://<account-id>.artifacts.cloudflare.net/git/default/<owner>--forge-e2e.git`; read_only false (open-beta command) |
| 7 | Config parse under pool-workers' pinned wrangler | nested `wrangler@4.124.0 deploy --dry-run` against `apps/platform/wrangler.jsonc` | dry-run OK; all bindings recognized incl. `env.ARTIFACTS` (Artifacts), 4 DOs, 4 Workflows, DB, SNAPSHOTS, EVENTS |
| 8 | Typecheck after provisioning | `npm run typecheck` (repo root) | **PASS** (exit 0) |

## MCP SDK Workers-compatibility verdict

**Verdict: workers-ready via specific export path.** No hand-rolled JSON-RPC fallback needed. Verified version: **@modelcontextprotocol/sdk 1.32.1** (latest; provisioned as `^1.32.1`).

**Exports inspected** (package.json exports map): `.`, `./client`, `./server`, `./validation`, `./validation/ajv`, `./validation/cfworker`, `./experimental`, `./experimental/tasks`, plus a `./*` wildcard. No browser/worker condition variants — all entries are plain ESM/CJS file mappings into `dist/esm` / `dist/cjs`.

- **The root `.` export is broken in 1.32.1**: it maps to `dist/esm/index.js`, which is absent from the published tarball. Node import → `ERR_MODULE_NOT_FOUND` (verified). Subpath imports are mandatory — this is fine, and it also keeps you away from Node-only code.
- **Node-only code found** (must NOT be imported by the Worker):
  - `server/streamableHttp.js` → imports `@hono/node-server` (it is merely a Node wrapper around the web-standard transport)
  - `server/sse.js` → `node:crypto`, `node:tls`, `node:url`
  - `server/stdio.js` → `node:process`
  - `server/express.js` → `express`
  - `server/auth/handlers/register.js` → `node:crypto`
  - `client/stdio.js` → `node:process`, `node:stream`
  - `experimental/tasks/stores/in-memory.js` → `node:crypto`
  - `examples/*` → various
- **Workers-safe paths** (import graph traced; zero `node:` imports):
  - `@modelcontextprotocol/sdk/server/mcp.js` → `McpServer`, `ResourceTemplate`
  - `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` → `WebStandardStreamableHTTPServerTransport` — the d.ts states it "can run on any runtime that supports Web Standards: Node.js 18+, Cloudflare Workers, Deno, Bun". Imports only `shared/mediaType` (via `content-type` pkg), `server/requestBody`, `server/sseKeepAlive`, `types` (zod/v4).
  - `@modelcontextprotocol/sdk/server/index.js` → low-level `Server`
  - Client side is also web-safe on the HTTP paths (`client/index.js`, `client/streamableHttp.js`; only `client/stdio.js` is Node-only) — matters if M6 E2E tests import the MCP client inside workerd.
- **Bundle proof** (run from `apps/platform` with the repo's esbuild 0.28.1, simulating wrangler: `--bundle --format=esm --platform=neutral --conditions=workerd --main-fields=browser,module,main`): mcp.js + webStandardStreamableHttp.js → **780 KB output, 0 `node:` builtin references**. Bundled packages: the SDK, ajv, ajv-formats, content-type, fast-deep-equal, fast-uri, json-schema-traverse, zod-to-json-schema, zod. Node import smoke test from `apps/platform`: all three server entry points import OK.
- **Recommended import path for M6** (Hono route in the Worker):
  ```ts
  import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
  // route handler: return transport.handleRequest(request)  // Request -> Response
  ```
- **Validation caveat (the one workerd landmine)**: the `Server` constructor defaults `jsonSchemaValidator ?? new AjvJsonSchemaValidator()` (`server/index.js:51`). Constructing Ajv is workerd-safe, but `ajv.compile()` uses `new Function` codegen (rejected by workerd) and is only reached when validating elicitation-form `requestedSchema` (`server/index.js:358`). If M6 uses structured elicitation, install the optional peer **`@cfworker/json-schema@^4.1.1`** (latest 4.1.1) and pass `new CfWorkerJsonSchemaValidator()` from `@modelcontextprotocol/sdk/validation/cfworker` — verified that this import currently fails without the peer installed. If M6 skips elicitation, the ajv default is inert and harmless.
- **zod peer** `^3.25 || ^4.0` satisfied by repo zod 4.4.3; the SDK uses `zod/v4`, `zod/v3`, `zod/v4-mini` subpaths, all present in zod 4.x.

## vitest-pool-workers compatibility

**Name trap first:** unscoped `vitest-pool-workers` on npm is a **0.0.1 placeholder package — not Cloudflare's**. The real package is `@cloudflare/vitest-pool-workers`. It was already present in this workspace at `^0.22.0` (dormant: no config or import references anywhere), so provisioning took the form of a caret bump to the verified latest.

- **Verified latest: 0.23.0** (this is the final release — see Surprises).
- **Peer deps**: `vitest ^4.1.0`, `@vitest/runner ^4.1.0`, `@vitest/snapshot ^4.1.0` → **compatible range: vitest ^4.1.0**. Repo vitest 4.1.11 satisfies it. vitest 5.x (latest 5.0.3) does NOT — do not upgrade vitest. No peer constraint on `@cloudflare/workers-types` (repo 5.20261007.1 / 5.x current — fine).
- **Proven by running**: scratch project with vitest 4.1.11 + pool-workers 0.23.0 — 2 tests executed **inside workerd** and passed (WebSocketPair/CacheStorage globals present).
- **Critical caveat for THIS repo**: pool-workers 0.23.0 pins `wrangler 4.124.0` + `miniflare 5.20260815.0-alpha` → **workerd 1.20260815.1 (built 2026-08-15)**. The repo's `compatibility_date` is **2026-10-01**, newer than that runtime → miniflare `ERR_RUNTIME_FAILURE` (observed; lowering the date to 2026-08-01 made the same tests pass). The successor **`@cloudflare/vitest-plugin@1.3.7`** bundles `wrangler 4.148.0` + `miniflare 5.20261006.0-alpha` (workerd 2026-10-06), has the identical peer range and the identical `cloudflareTest` API, and **verified passing at compatibility_date 2026-10-01**.
- **Config shape** (vitest 4 style; the shipped `vitest-v3-to-v4` codemod moves `test.poolOptions.workers` → `plugins: [cloudflareTest(...)]`):
  ```ts
  import { defineConfig } from "vitest/config";
  import { cloudflareTest } from "@cloudflare/vitest-pool-workers"; // or "@cloudflare/vitest-plugin"
  export default defineConfig({
    plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
    test: { include: ["test/**/*.test.ts"] },
  });
  ```
- **Options schema** (zod, both packages): `main`, `remoteBindings` (**default true**), `verbose`, `additionalExports` (`Record<string, "WorkerEntrypoint" | "DurableObject" | "WorkflowEntrypoint">`), `miniflare.workers[]`, `wrangler.configPath/environment`.
- **Config caveats for this Worker app (Artifacts remote binding, D1, R2, queues, 4 DOs, 4 workflows):**
  1. `ARTIFACTS` (remote: true): `remoteBindings` defaults to **true** → tests reach the real Artifacts namespace using the local wrangler OAuth against account `<account-id>` out of the box. Set `remoteBindings: false` for hermetic tests; plan a live-vs-hermetic split for M-mission CI tests.
  2. DO/Workflow classes: all 8 (`TokenCache`, `RateLimiter`, `RealtimeHub`, `MergeLock`; `SnapshotBuilder`, `CiPipeline`, `MergeWorkflow`, `RepoImport`) are exported from `apps/platform/src/index.ts:8-9`, so the pool auto-derives the worker export map (`guessWorkerExports`); `additionalExports` is available as an explicit override.
  3. **No workers-pool test config exists yet**: root `vitest.config.ts` is `environment: 'node'` and includes only `packages/**/test/**`; `apps/platform` has a `test` script but no `vitest.config`. The mission must add `apps/platform/vitest.config.ts` (or extend the root config with projects) using the pattern above — preferably with `@cloudflare/vitest-plugin`.
  4. `smart_placement` in `wrangler.jsonc` is no longer a recognized wrangler key — wrangler 4.148 warns on every command that parses the config (observed on `d1 execute` and dry-run). The schema key today is `placement`. Harmless to deploys; clean it up before mission config work.
  5. Nested wrangler: pool-workers installs its own `wrangler 4.124.0` under `@cloudflare/vitest-pool-workers/node_modules` (root keeps 4.148.0); verified it still parses `wrangler.jsonc` including the `artifacts` binding. `@cloudflare/vitest-plugin@1.3.7` pins wrangler 4.148.0 — same as the repo, so it dedupes to one copy.
  6. Shipped test utilities (`@cloudflare/vitest-pool-workers/types` → `cloudflare-test.d.ts`) map 1:1 onto mission features: `applyD1Migrations` (D1), `createMessageBatch`/`getQueueResult` (queue consumers — M4 events), `runInDurableObject`/`evictDurableObject`/alarm helpers (DOs), `introspectWorkflowInstance`/`modify`/`mockStepResult`/`mockStepError`/`disableRetryDelays` (workflows — M5 CI/merge/snapshots).
  7. npm blocked `workerd`/`esbuild` postinstall scripts in this environment (allowScripts warnings) — binaries verified working regardless (`workerd 2026-08-15` prints version; esbuild 0.28.1 bundles). Not a blocker.

## Provisioned

Exact diff to `apps/platform/package.json` (the only source-tree change; `package-lock.json` updated by install; no source code modified):

```diff
   "dependencies": {
     "@forge/diffcore": "*",
     "@forge/gitops": "*",
     "@forge/ui": "*",
+    "@modelcontextprotocol/sdk": "^1.32.1",
     "@workos/authkit-session": "^0.7.1",
     "hono": "^4.6.0",
     "markdown-it": "^15.0.2"
   },
   "devDependencies": {
-    "@cloudflare/vitest-pool-workers": "^0.22.0",
+    "@cloudflare/vitest-pool-workers": "^0.23.0",
     "@cloudflare/workers-types": "^5.20261007.0",
     "@types/markdown-it": "^14.2.0",
     "vitest": "^4.1.0",
     "wrangler": "^4.148.0"
   }
```

- `npm install` from repo root resolved: `@modelcontextprotocol/sdk` **1.32.1**, `@cloudflare/vitest-pool-workers` **0.23.0** (nested wrangler 4.124.0), vitest stays **4.1.11**, wrangler stays **4.148.0**, zod stays **4.4.3**.
- `npm run typecheck` — PASS.
- Note: "vitest-pool-workers" already existed here at `^0.22.0`, so the verified provision is a caret bump to `^0.23.0` rather than a new entry. The unscoped `vitest-pool-workers` npm package (0.0.1 placeholder) was deliberately NOT installed.

## Blockers

None blocking mission start. Two decisions needed during the mission:

1. **In-Worker tests of the platform app cannot run under `@cloudflare/vitest-pool-workers@0.23.0` at `compatibility_date` 2026-10-01** (its bundled workerd 2026-08-15 predates the date; verified `ERR_RUNTIME_FAILURE`). Options:
   - (a) **Recommended**: switch the devDep to `@cloudflare/vitest-plugin@^1.3.7` (verified passing at 2026-10-01; identical peer range and `cloudflareTest` API; bundles wrangler 4.148.0 matching the repo). One-line change when the first in-Worker test is wired.
   - (b) Lower `compatibility_date` to ≤ 2026-08-15 — changes deployed runtime semantics; not advisable.
   - (c) Keep pool-workers purely for the Node-env `packages/**` tests and rely on `wrangler dev` + HTTP for platform tests — loses in-Worker binding access and the shipped DO/queue/workflow utilities.
2. **`@cfworker/json-schema@^4.1.1` must be installed if M6 uses structured elicitation** (otherwise the default ajv validator would hit workerd's `new Function` restriction at compile time). One-line dependency add, deferred until the M6 design decides on elicitation.

## Surprises

1. **`@cloudflare/vitest-pool-workers` is deprecated and renamed to `@cloudflare/vitest-plugin`** — README banner says it "will not receive future updates"; migration codemod: `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`. The successor (1.3.7) is peer-compatible with the repo's vitest and matches the repo's wrangler exactly.
2. **Compat-date/runtime skew**: the repo targets a compatibility date newer than the pool's bundled runtime. This is the single most likely first-day failure for M-mission test setup; both the failure and the successor's success at this date were reproduced.
3. Unscoped `vitest-pool-workers` on npm is a 0.0.1 placeholder — never install it.
4. **MCP SDK 1.32.1's root `.` export is broken** (missing `dist/esm/index.js`). Always import subpaths — conveniently, the correct Workers path is a subpath anyway.
5. The SDK's `server/streamableHttp.js` is only an `@hono/node-server` wrapper around `WebStandardStreamableHTTPServerTransport` — the web-standard subpath is the intended (and documented) path for Workers.
6. `smart_placement` is no longer a recognized wrangler top-level key (wrangler 4.148 warns on every config parse); the modern key is `placement`.
7. `remoteBindings` defaults to **true** in the test pool — Artifacts remote binding hits the real account in tests by default; plan hermetic vs live test separation accordingly.
8. Latest vitest is 5.0.3 — **do not upgrade vitest to 5.x**; the Cloudflare test integration peers on `^4.1.0`.
9. The `workerd`/`esbuild` postinstall blocks (npm allowScripts) are cosmetic here — binaries verified functional.
