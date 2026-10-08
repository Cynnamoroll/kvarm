# forge CLI

`apps/cli` is the Veyr-9 command-line client. It needs Node 20 or later and
has no runtime dependencies.

```bash
npm install                      # from the repo root; links the `forge` bin
export FORGE_BASE_URL=https://forge-platform.cynnamoroll.workers.dev
export FORGE_PAT=...             # personal access or agent token
npx forge checkout cynthia/demo main ./demo
# or: node apps/cli/bin/forge.js checkout cynthia/demo main ./demo
```

## Configuration

| variable | meaning |
| --- | --- |
| `FORGE_BASE_URL` | Platform origin (required). |
| `FORGE_PAT` | Token for private repositories and snapshot demands. A PAT needs the `api` scope to call the snapshot API; git access needs `read`. |

The token goes to the REST API as `Authorization: Bearer` and to git as a
basic-auth header scoped to `FORGE_BASE_URL`. It is passed through
`GIT_CONFIG_*` environment variables, never on the command line. Git runs with
credential helpers disabled and terminal prompts off, so no credential store
is read or written.

## `forge checkout <owner/repo> <ref> <dir>`

Materializes a branch, tag or full commit SHA into `<dir>`, which must be
missing or empty.

1. With `FORGE_PAT`, checkout sends the explicit snapshot demand
   `POST /api/v1/repos/<owner>/<repo>/snapshots/<ref>`. Default-branch
   snapshots build eagerly on push. Other branches and workspace refs build
   lazily, so this demand is what starts their build. Without a token,
   checkout only reads the metadata (`GET`) and never starts a build.
2. If the snapshot is ready, checkout downloads
   `…/snapshots/<sha>/download` by commit SHA, so a branch that moves mid-run
   cannot swap the content. It checks that the byte count equals the metadata
   `size` and extracts the tarball. Output: `source: snapshot`.
3. Otherwise it runs `git clone --no-checkout` + `git checkout <ref>`.
   Output: `source: clone`. This covers a build in progress (including the one
   this checkout just demanded), an absent or failed snapshot, a refused
   token, an unreachable API and a bad download. A partial extraction is
   removed before the clone. A later checkout of the same ref uses the
   snapshot once the demanded build is ready.

stdout always starts with the pinned `source:` line, followed by `sha:
<commit>` (plus `files:` and `bytes:` for a snapshot). The reason for a
fallback goes to stderr. Exit status: 0 on success, 1 on failure (for
example an unknown ref or a private repo without a token), 2 on usage errors.

The extractor handles the snapshot builder's ustar/pax archives: modes,
symlinks, long and unicode paths. It refuses absolute and `..` paths, and it
creates symlinks only after all other entries, so no entry can be written
through a link.

### Snapshots have no git history

A snapshot checkout is the tree of one commit. It has no `.git` directory, no
history and no refs. To commit and push from it, attach it to the repository
first:

```bash
cd <dir>
git init -q
git remote add origin "$FORGE_BASE_URL/<owner>/<repo>.git"
git fetch -q origin <sha>          # the sha printed by forge checkout
git reset -q <sha>                 # HEAD and index at <sha>; working files untouched
git switch -q -c <new-branch>
# edit, commit, then: git push origin <new-branch>
```

`git status` is clean right after the reset, because the snapshot tree equals
the commit tree. `scripts/cli-checkout-e2e.mjs` checks this recipe live,
including the final push. When an agent needs history from the start, a clone
is the better choice.

## Performance

See `docs/benchmarks/clone-vs-snapshot.md` (`scripts/bench-clone-vs-snapshot.mjs`).
Downloads go through `node:https` rather than the global `fetch`. On the
benchmark host, `fetch` streamed the 33 MB fixture tarball at about half the
throughput of `node:https` and curl.

## Tests

`apps/cli/test` runs in the root vitest `packages` project
(`npx vitest run --project packages apps/cli`). The tests extract archives
built with `@forge/gitops`'s tar writer and with `git archive`, and compare
the result against real `git checkout` trees. They also cover path-traversal
and symlink-escape archives, every fallback path, and the `forge` bin against
a local server: a fake snapshot API plus `git http-backend` for the clone.
