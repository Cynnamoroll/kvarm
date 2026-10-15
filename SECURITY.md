# Security policy

Kvarm hosts git repositories and hands out credentials to people and agents, so we treat security reports as the most urgent kind of contribution.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting for [kvarm-git/kvarm](https://github.com/kvarm-git/kvarm): open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion about an unfixed vulnerability. If the private form is not available, open a public issue that asks the maintainers for a private contact and contains no details of the problem.

Include what you can of:

- the affected surface (git smart-HTTP, REST `/api/v1`, MCP `/mcp`, pages, the `kvarm` CLI or runner, a script) and the commit you tested
- steps to reproduce, with the requests and responses (status codes, `x-kvarm-cost` headers) involved
- the impact you see: what an attacker can read, write or deny, and with which credentials
- whether you tested against your own deployment (please do; see below)

Never include a working token. Revoke any token that appears in a report.

## What to expect

We aim to acknowledge a report within a few days, keep you updated while we investigate, and tell you when a fix lands. We credit reporters in the fix's commit or pull request unless you ask us not to. Please give us a reasonable time to fix the problem before you disclose it publicly; we will agree on a date with you.

## Scope

In scope: the code in this repository, including the Worker (`apps/platform`), the CLI and CI runner (`apps/cli`), the container runner payload (`packages/container-runner`), the packages and the scripts. Examples of what we want to hear about:

- access to a repository, organization, token or agent principal you should not reach, on any surface (git, REST, MCP or pages), including through caching
- a private repository whose existence an outsider can detect
- an agent token that writes outside its repository, ref patterns or expiry
- a push, merge or queue path that bypasses branch rules, required checks or approvals
- a snapshot, tarball or runner path that writes outside its target directory
- secrets written to logs, responses, snapshots or containers

Out of scope: findings that need a compromised Cloudflare account or a malicious instance admin, rate limiting you can only exceed by owning many accounts, missing security headers without a concrete impact, and reports produced only by automated scanners.

Test against a deployment you run yourself (the README's [Deploy from zero](README.md#deploy-from-zero) creates one). Do not test against deployments other people operate, do not access other people's data, and do not degrade a service for others.

## CI runner threat model

`kvarm runner` executes `.kvarm/ci.json` commands, which are code from whoever pushed the commit. On Kvarm that is routinely an agent, so treat every job as potentially hostile unless the runner's trust policy says otherwise.

- **Environment filtering is not a sandbox.** On the host, a job sees only `PATH`, `HOME`, `LANG`, `LC_*`, `TZ` and `TMPDIR` (plus `GIT_TERMINAL_PROMPT=0`), so the runner's `KVARM_PAT`, version-control credentials and cloud keys in its environment do not pass. The job still runs as your user: it can read `~/.ssh`, `~/.config`, other repositories and any token stored on disk (including a `.env.local` holding the runner's own PAT), on Linux the runner's own environment through `/proc/<pid>/environ` (so its `KVARM_PAT` too), and it can send what it reads anywhere over the network. The same holds inside the hosted Container CI runner, whose job command runs as the same user as the runner process: its isolation from the platform's other repositories comes from the throwaway container and the repository-scoped `ci` token, not from environment filtering.
- **The trust policy decides before anything runs.** The default, `--trust humans`, runs on the host only the exact head of a change a human opened outside the agent workspace namespace; agent-authored changes, agent workspace refs, platform-prepared merge commits (which can include other queued changes) and jobs without provenance run in a container or are refused and reported as failures. `--trust all` runs everything on the host and warns on every job; use it only for repositories whose every pusher you trust. The hosted container drain runs with `trust: 'all'` inside its own throwaway container: every repository's jobs run there, including agent-authored work a user's host runner would refuse, and the boundary is the container plus an ephemeral repository-scoped `ci` token (2 h expiry, revoked at the end of each drain) held by a non-admin service identity.
- **The container executor is the isolation boundary.** A job container (docker or podman) gets the job's working directory as its only writable host mount, a read-only root, no capabilities, no privilege escalation, CPU, memory and process limits, the filtered environment without host paths, and is killed on timeout. It keeps network access unless you pass `--network none` (the runner refuses `--network host` and `container:` modes), and it is only as strong as your container runtime. Container jobs never share a working directory with host jobs. A container started by a runner that is itself killed mid-job keeps running until it exits; `docker ps --filter name=kvarm-job-` finds it.
- **What `humans` cannot see.** The platform records who opened a change, not who pushed its head, so `humans` trusts a head only when no agent credential could have written its ref: not an agent workspace ref, and not matched by any write agent token's grant on the repository (revoked and expired tokens included). A human who pushes an agent's commit to such a ref vouches for it, and every human with write access is trusted alike. Where that matters, run with `--trust none` or `--executor container`.

A runner escape (a job reaching files outside its working directory, the runner's credentials, or another job's working directory under the container executor) is in scope for the reports above.

## Supported versions

Kvarm is developed on `main`, and fixes land there. There are no separately maintained release branches.

## Handling credentials in this repository

Kvarm tokens have a recognizable format (`kvarm_pat_…`, `kvarm_agt_…`) so that `kvarm/guard` and other secret scanners can flag them. Tokens belong in gitignored env files such as `.env.local`, are passed to git through a secret-free `GIT_ASKPASS` helper, and are never printed by the scripts in this repository. If you commit a token by accident, revoke it first (`DELETE /api/v1/user/tokens/:id` from a signed-in session, or delete its `pat` row in your deployment's D1; `scripts/mint-pat.mjs` prints the id), then remove it from the change.
