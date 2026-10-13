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

In scope: the code in this repository, including the Worker (`apps/platform`), the CLI and CI runner (`apps/cli`), the packages and the scripts. Examples of what we want to hear about:

- access to a repository, organization, token or agent principal you should not reach, on any surface (git, REST, MCP or pages), including through caching
- a private repository whose existence an outsider can detect
- an agent token that writes outside its repository, ref patterns or expiry
- a push, merge or queue path that bypasses branch rules, required checks or approvals
- a snapshot, tarball or runner path that writes outside its target directory
- secrets written to logs, responses, snapshots or containers

Out of scope: findings that need a compromised Cloudflare account or a malicious instance admin, rate limiting you can only exceed by owning many accounts, missing security headers without a concrete impact, and reports produced only by automated scanners.

Test against a deployment you run yourself (the README's [Deploy from zero](README.md#deploy-from-zero) creates one). Do not test against deployments other people operate, do not access other people's data, and do not degrade a service for others.

## Supported versions

Kvarm is developed on `main`, and fixes land there. There are no separately maintained release branches.

## Handling credentials in this repository

Kvarm tokens have a recognizable format (`kvarm_pat_…`, `kvarm_agt_…`) so that `kvarm/guard` and other secret scanners can flag them. Tokens belong in gitignored env files such as `.env.local`, are passed to git through a secret-free `GIT_ASKPASS` helper, and are never printed by the scripts in this repository. If you commit a token by accident, revoke it first (`DELETE /api/v1/user/tokens/:id` from a signed-in session, or delete its `pat` row in your deployment's D1; `scripts/mint-pat.mjs` prints the id), then remove it from the change.
