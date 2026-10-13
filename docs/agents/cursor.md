# Cursor

Status: verified with the Cursor agent CLI 2026.10.01 (`cursor-agent`, the agent bundled with Cursor 3.21) against a local Kvarm instance (`wrangler dev -c wrangler.dev.jsonc`) and an agent token: the `mcp.json` below, including `${env:KVARM_AGENT_TOKEN}` interpolation in `headers`, sends `Authorization: Bearer <token>`, and `cursor-agent mcp list-tools kvarm` lists the registry's tools. Older agent CLIs (2025.09 builds) do not send `headers` for URL servers at all and fall back to OAuth discovery, which Kvarm does not offer; update with Cursor's installer if you see `Invalid OAuth error response` or a 401. Fields marked *uncertain* were not exercised.

## Prerequisites

- Cursor with MCP support.
- A Kvarm deployment (`<KVARM_ORIGIN>`) and a repository `<owner>/<repo>`.
- An agent token (see [README.md](README.md#create-an-agent-token)) exported in the environment Cursor is launched from:

```sh
export KVARM_AGENT_TOKEN='<AGENT_TOKEN>'
```

Launch Cursor from that shell (for example `cursor .`) so it inherits the variable; a Dock or Start-menu launch does not (*uncertain* on your OS).

## Configure

Create `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "kvarm": {
      "url": "<KVARM_ORIGIN>/mcp",
      "headers": { "Authorization": "Bearer ${env:KVARM_AGENT_TOKEN}" }
    }
  }
}
```

Cursor asks you to approve a project MCP server before it loads it, and again whenever the server's entry changes: accept the prompt in the editor, or run `cursor-agent mcp enable kvarm` in the project (`--approve-mcps` approves for a single `cursor-agent` run).

If you must write the literal header value instead of `${env:...}`, keep the file out of version control (add it to `.gitignore`). Never commit a file that contains a real token.

## Verify

From a terminal in the project: `cursor-agent mcp list-tools kvarm` lists the tools (for example `- get_repo (repo)`). In the editor, open Cursor Settings, then the MCP section: `kvarm` should show a green status and list the registry's tools. In the agent chat ask: "Call the kvarm `get_repo` tool for `<owner>/<repo>`." Expect a `repo` object. A personal access token can call `list_repos`; an agent token cannot (`AGENT_FORBIDDEN`).

## Troubleshooting

- `MCP server "kvarm" has not been approved`: approve it (see Configure); editing the entry requires approving it again.
- `Invalid OAuth error response` or a 401 with a fresh token: your agent CLI predates header support for URL servers; update it.
- Red status or "no tools": toggle the server off and on after fixing the file; Cursor reads the config on change but not the environment after launch.
- 401: the token or variable is wrong, or the token expired or was revoked.
- 403 `INSUFFICIENT_SCOPE`: a personal access token without `api`.
- Cursor shows a tool-count limit warning: disable tools you do not use in the MCP settings (a client-side limit, *uncertain* per version).
- Everything else: [README.md](README.md#troubleshooting-all-clients).

Next: [workflow.md](workflow.md). For project rules, put [AGENTS.template.md](AGENTS.template.md) at the repository root as `AGENTS.md`, or copy it into a `.cursor/rules` file (*uncertain* whether your version reads `AGENTS.md`).
