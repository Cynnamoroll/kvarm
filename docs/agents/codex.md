# OpenAI Codex CLI

Status: the `config.toml` keys below follow the Codex CLI MCP documentation for Streamable HTTP servers (`url`, `bearer_token_env_var`). Fields marked *uncertain* depend on your Codex version; check the Codex documentation for the version you run. Against a Kvarm instance, only the MCP protocol path was exercised with a generic client (see [generic.md](generic.md)); the `codex` binary itself was not run against it.

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

`bearer_token_env_var` names the environment variable whose value Codex sends as `Authorization: Bearer <value>`, so the token never appears in the file. If your version has no `bearer_token_env_var`, use the static or env-backed header tables instead (*uncertain*, check the key names in your version's documentation):

```toml
[mcp_servers.kvarm]
url = "<KVARM_ORIGIN>/mcp"
env_http_headers = { "Authorization" = "KVARM_AUTHORIZATION" }   # env var holds the full value: Bearer <AGENT_TOKEN>
```

Some older Codex versions gate Streamable HTTP servers behind an experimental flag (*uncertain*); if `codex mcp list` shows no `kvarm` entry or the server fails to start, check the release notes for your version.

Restart Codex after editing the file.

## Verify

```sh
codex mcp list           # kvarm should be listed
```

In a Codex session, ask it to call the `kvarm` `get_repo` tool for `<owner>/<repo>` and expect a `repo` object. A personal access token can call `list_repos`; an agent token cannot (`AGENT_FORBIDDEN`, account-level).

## Troubleshooting

- 401 although the token is fresh: your Codex version may ignore the key you used and send no `Authorization` header; check the key names against the documentation for your version.
- Startup error about the server or a 401: the environment variable is unset in the shell that launched Codex, or the token is expired or revoked. Mint a new one and restart Codex.
- 403 `INSUFFICIENT_SCOPE`: a personal access token without `api`.
- Codex reports the server as unsupported: your version may only speak stdio MCP servers; update Codex or bridge with a generic stdio-to-HTTP MCP proxy (not covered here).
- `AGENT_FORBIDDEN`, 404, push rejections: see [README.md](README.md#troubleshooting-all-clients).

Next: [workflow.md](workflow.md) and [AGENTS.template.md](AGENTS.template.md). Codex reads `AGENTS.md` natively, so the template works as is.
