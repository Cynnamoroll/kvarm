# OpenAI Codex CLI

Status: verified with Codex CLI 0.154.0 against a local Kvarm instance (`wrangler dev -c wrangler.dev.jsonc`) and an agent token: `codex mcp list` shows `kvarm` as a Streamable HTTP server with bearer-token auth, and `codex exec` called `get_repo` successfully (`mcp: kvarm/get_repo (completed)`). Fields still marked *uncertain* were not exercised.

## Prerequisites

- Codex CLI installed (`codex --version`).
- A Kvarm deployment (`<KVARM_ORIGIN>`) and a repository `<owner>/<repo>`.
- An agent token (see [README.md](README.md#create-an-agent-token)) exported in the environment Codex starts from:

```sh
export KVARM_AGENT_TOKEN='<AGENT_TOKEN>'
```

## Configure

Add a server table to `~/.codex/config.toml` (user level; a project-level `.codex/config.toml` also works in versions that support it, *uncertain*):

```toml
[mcp_servers.kvarm]
url = "<KVARM_ORIGIN>/mcp"
bearer_token_env_var = "KVARM_AGENT_TOKEN"
```

`bearer_token_env_var` names the environment variable whose value Codex sends as `Authorization: Bearer <value>`, so the token never appears in the file. Codex 0.154 also supports an env-backed header table, if you prefer to keep the full header value in the environment (the key exists in 0.154; the verified path is `bearer_token_env_var`):

```toml
[mcp_servers.kvarm]
url = "<KVARM_ORIGIN>/mcp"
env_http_headers = { "Authorization" = "KVARM_AUTHORIZATION" }   # env var holds the full value: Bearer <AGENT_TOKEN>
```

Codex 0.154 needs no experimental flag for Streamable HTTP servers. Older versions may (*uncertain*); if `codex mcp list` shows no `kvarm` entry or the server fails to start, check the release notes for your version.

To try the server without editing `config.toml`, pass the same keys as overrides: `codex -c 'mcp_servers.kvarm.url="<KVARM_ORIGIN>/mcp"' -c 'mcp_servers.kvarm.bearer_token_env_var="KVARM_AGENT_TOKEN"' mcp list`.

Restart Codex after editing the file.

## Verify

```sh
codex mcp list           # kvarm: Status enabled, Auth Bearer token
codex mcp get kvarm      # transport: streamable_http, bearer_token_env_var: KVARM_AGENT_TOKEN
```

In a Codex session, ask it to call the `kvarm` `get_repo` tool for `<owner>/<repo>` and expect a `repo` object. A personal access token can call `list_repos`; an agent token cannot (`AGENT_FORBIDDEN`, account-level).

## Troubleshooting

- 401 although the token is fresh: your Codex version may ignore the key you used and send no `Authorization` header; check the key names against the documentation for your version.
- Startup error about the server or a 401: the environment variable is unset in the shell that launched Codex, or the token is expired or revoked. Mint a new one and restart Codex.
- 403 `INSUFFICIENT_SCOPE`: a personal access token without `api`.
- Codex reports the server as unsupported: your version may only speak stdio MCP servers; update Codex or bridge with a generic stdio-to-HTTP MCP proxy (not covered here).
- `AGENT_FORBIDDEN`, 404, push rejections: see [README.md](README.md#troubleshooting-all-clients).

Next: [workflow.md](workflow.md) and [AGENTS.template.md](AGENTS.template.md). Codex reads `AGENTS.md` natively, so the template works as is.
