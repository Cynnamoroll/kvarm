# Cursor

Status: the `mcp.json` format below follows the Cursor MCP documentation for remote servers (`url` plus `headers`, with `${env:NAME}` interpolation). Fields marked *uncertain* depend on your Cursor version. Against a Kvarm instance, only the MCP protocol path was exercised with a generic client (see [generic.md](generic.md)); Cursor itself was not run against it.

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

If your Cursor version does not interpolate `${env:...}` in `headers`, write the literal header value instead and keep the file out of version control (add it to `.gitignore`). Never commit a file that contains a real token.

## Verify

Open Cursor Settings, then the MCP section: `kvarm` should show a green status and list the registry's tools. In the agent chat ask: "Call the kvarm `get_repo` tool for `<owner>/<repo>`." Expect a `repo` object. A personal access token can call `list_repos`; an agent token cannot (`AGENT_FORBIDDEN`).

## Troubleshooting

- Red status or "no tools": toggle the server off and on after fixing the file; Cursor reads the config on change but not the environment after launch.
- 401: the token or variable is wrong, or the token expired or was revoked.
- 403 `INSUFFICIENT_SCOPE`: a personal access token without `api`.
- Cursor shows a tool-count limit warning: disable tools you do not use in the MCP settings (a client-side limit, *uncertain* per version).
- Everything else: [README.md](README.md#troubleshooting-all-clients).

Next: [workflow.md](workflow.md). For project rules, put [AGENTS.template.md](AGENTS.template.md) at the repository root as `AGENTS.md`, or copy it into a `.cursor/rules` file (*uncertain* whether your version reads `AGENTS.md`).
