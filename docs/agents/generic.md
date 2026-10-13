# Generic Streamable HTTP MCP client

Status: verified against a local `wrangler dev` instance (`wrangler.dev.jsonc`, no Cloudflare account) with a Node `fetch` script and `scripts/mcp-agent.mjs`: `initialize`, `tools/list`, `tools/call` (`list_repos` with a PAT, `get_repo` with an agent token), the 401, 405, 406 and `AGENT_FORBIDDEN` cases, token revocation and token expiry. Repository content tools were not exercised because the offline configuration has no Artifacts binding. This is the protocol every other guide relies on.

## Prerequisites

- A Kvarm deployment (`<KVARM_ORIGIN>`) and a repository `<owner>/<repo>`.
- An agent token (see [README.md](README.md#create-an-agent-token)):

```sh
export KVARM_AGENT_TOKEN='<AGENT_TOKEN>'
```

## Protocol facts

- Endpoint: `POST <KVARM_ORIGIN>/mcp`. `GET` answers 405.
- Stateless: no session id, no server-sent stream; every request is answered with one JSON body. Responses are `application/json`.
- Headers: `Authorization: Bearer <AGENT_TOKEN>`, `Content-Type: application/json`, and `Accept: application/json, text/event-stream` (the SDK transport requires both media types in `Accept`).
- Tool calls take the registry parameters as `arguments` (camelCase for body fields, `repo` as `owner/name`).
- A failing tool returns HTTP 200 with `result.isError: true` and a text body `{"status": ..., "error": "...", "code": "..."}`. Authentication failures are real HTTP 401 or 403 before JSON-RPC starts.

## Configuration

Whatever the client calls it, it needs three things: transport `streamable-http` (also called `http`), URL `<KVARM_ORIGIN>/mcp`, and the header `Authorization: Bearer <AGENT_TOKEN>`. Prefer a setting that reads the token from an environment variable or secret store over one that stores it in a plain file.

## Verify with curl

```sh
MCP="<KVARM_ORIGIN>/mcp"
HDR=(-H "Authorization: Bearer $KVARM_AGENT_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")

# 1. initialize: expect serverInfo.name "Kvarm"
curl -s -X POST "$MCP" "${HDR[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2. tools/list: expect the registry's tools
curl -s -X POST "$MCP" "${HDR[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. tools/call: get_repo works with an agent token
curl -s -X POST "$MCP" "${HDR[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_repo","arguments":{"repo":"<owner>/<repo>"}}}'
```

With a personal access token (scope `api`) the same calls work, and `list_repos` with `"arguments":{}` returns your repositories. With an agent token `list_repos` returns `isError` with `status` 403 and `code` `AGENT_FORBIDDEN`.

The repository also ships a scripted client built on the official SDK: `KVARM_BASE_URL=<KVARM_ORIGIN> node scripts/mcp-agent.mjs info` prints the server identity and tool count, and `node scripts/mcp-agent.mjs call get_repo '{"repo":"<owner>/<repo>"}'` makes one tool call (the token comes from the environment variable named by `MCP_TOKEN_ENV`, default `KVARM_PAT`).

## Troubleshooting

- `401 {"error":"unauthorized","code":"UNAUTHENTICATED"}` with no `Authorization` header, a malformed token, or an expired or revoked one.
- `406 Not Acceptable` or a transport error from the MCP layer: the `Accept` header lacks one of the two media types.
- `400` Parse error: the body is not valid JSON; `413`: the body exceeds 1 MiB.
- Everything else: [README.md](README.md#troubleshooting-all-clients).

Next: [workflow.md](workflow.md).
