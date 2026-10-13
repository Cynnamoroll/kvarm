# Claude Code

Status: the HTTP/`.mcp.json` syntax below follows the Claude Code MCP documentation. Against a Kvarm instance, only the MCP protocol path was exercised with a generic client (see [generic.md](generic.md)); the `claude` binary itself was not run against it. Check `claude mcp add --help` if your version differs.

## Prerequisites

- Claude Code installed (`claude --version`).
- A Kvarm deployment (`<KVARM_ORIGIN>`) and a repository `<owner>/<repo>` the agent should work in.
- An agent token. Create it as described in [README.md](README.md#create-an-agent-token): `create_agent`, then `create_agent_token` with `role: "write"` and `refs: ["refs/heads/agents/*"]`.

```sh
export KVARM_AGENT_TOKEN='<AGENT_TOKEN>'
```

## Configure

Preferred: a project `.mcp.json` that reads the token from the environment (Claude Code expands `${VAR}` in `.mcp.json`), so no secret is written to a file you might commit:

```json
{
  "mcpServers": {
    "kvarm": {
      "type": "http",
      "url": "<KVARM_ORIGIN>/mcp",
      "headers": { "Authorization": "Bearer ${KVARM_AGENT_TOKEN}" }
    }
  }
}
```

Alternative, the command line:

```sh
claude mcp add --transport http kvarm "<KVARM_ORIGIN>/mcp" \
  --header "Authorization: Bearer $KVARM_AGENT_TOKEN"
```

The shell expands `$KVARM_AGENT_TOKEN` before Claude Code sees it, so the real token is stored in Claude Code's own config. Keep the default `local` scope; do not combine this form with `--scope project`, which writes a shareable `.mcp.json` containing the token.

## Verify

```sh
claude mcp list          # kvarm should be listed as connected
```

In a Claude Code session, ask: "Call the kvarm `get_repo` tool for `<owner>/<repo>`." Expect a `repo` object. With a personal access token (human use), ask for `list_repos` instead; an agent token answers `list_repos` with `AGENT_FORBIDDEN` because it is account-level.

## Troubleshooting

- `claude mcp list` shows the server as failed with 401: the token is wrong, expired or revoked; re-run `create_agent_token`, update `KVARM_AGENT_TOKEN` and restart Claude Code (the variable is read at startup).
- 403 `INSUFFICIENT_SCOPE`: you configured a personal access token that lacks the `api` scope.
- A tool call fails with `AGENT_FORBIDDEN`: see the table in [README.md](README.md#what-an-agent-token-can-and-cannot-do).
- Pushes rejected: the token's `refs` patterns do not cover `refs/heads/agents/<workspaceId>/<slug>`; see [workflow.md](workflow.md).
- The remaining cases are in [README.md](README.md#troubleshooting-all-clients).

Next: [workflow.md](workflow.md) and [AGENTS.template.md](AGENTS.template.md).
