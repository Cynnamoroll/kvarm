/**
 * MCP server at POST /mcp: Streamable HTTP in stateless mode, one McpServer
 * and one transport per request, JSON responses (no SSE stream, no sessions,
 * no elicitation).
 *
 * Tools are the shared operation registry (@forge/ops), the same list the
 * `forge` CLI exposes. A tool call is dispatched in-process to the REST route
 * the registry names, with the caller's Bearer token, so permission checks,
 * error codes and work counters are those of the REST call. A non-2xx REST
 * reply becomes an `isError` result carrying `{status, error, code}`; the
 * JSON-RPC exchange itself still completes with HTTP 200.
 *
 * Authentication: a Bearer token is required (401 otherwise). For a tool call
 * the token is verified by the REST route's own authority lookup (observed
 * through observePrincipals), so the call costs exactly its REST equivalent;
 * every other method verifies it with one authoritative lookup here.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { OPERATIONS, OperationInputError, buildRequest, requestTarget } from '@forge/ops';
import { patHash, readPatCache, scopesAllow, type PATInfo } from '../auth/pat';
import { observePrincipals, resolvePAT, tokenKind } from '../services/access';

export const MCP_SERVER_INFO = { name: 'veyr-9', version: '0.1.0' } as const;

/** Largest JSON-RPC request body accepted. */
const MAX_BODY_BYTES = 1024 * 1024;

type Operation = (typeof OPERATIONS)[number];
type Param = Operation['params'][number];
type ServerOptions = NonNullable<ConstructorParameters<typeof McpServer>[1]>;

/** Dispatches an internal REST request through the Worker's router. */
export type Dispatch = (request: Request) => Promise<Response>;

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Elicitation is not offered, so no JSON Schema is ever validated by the
 * server; this keeps the SDK's default Ajv validator (and its code
 * generation, which Workers forbid) out of every request.
 */
const NO_SCHEMA_VALIDATOR: ServerOptions['jsonSchemaValidator'] = {
  getValidator: () => () => ({ valid: false, data: undefined, errorMessage: 'JSON Schema validation is not available' }),
};

function paramSchema(p: Param): z.ZodType {
  let s: z.ZodType;
  switch (p.type) {
    case 'integer':
      s = z.number().int();
      break;
    case 'boolean':
      s = z.boolean();
      break;
    case 'string[]':
      s = z.array(z.string());
      break;
    case 'json':
      s = z.unknown();
      break;
    default:
      s = p.enum ? z.enum(p.enum as [string, ...string[]]) : z.string();
  }
  s = s.describe(p.description);
  return p.required ? s : s.optional();
}

let shapes: Map<string, Record<string, z.ZodType>> | undefined;

/** Zod input shapes for every operation, built once per isolate. */
function inputShapes(): Map<string, Record<string, z.ZodType>> {
  shapes ??= new Map(OPERATIONS.map((op) => [op.name, Object.fromEntries(op.params.map((p) => [p.name, paramSchema(p)]))]));
  return shapes;
}

const text = (data: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }];

function errorResult(status: number, error: string, code: string): ToolResult {
  return { isError: true, content: text({ status, error, code }) };
}

interface CallContext {
  origin: string;
  authorization: string;
  clientIp: string | null;
  dispatch: Dispatch;
}

async function callOperation(op: Operation, args: Record<string, unknown>, cx: CallContext): Promise<ToolResult> {
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  let built;
  try {
    built = buildRequest(op, clean);
  } catch (err) {
    if (err instanceof OperationInputError) return errorResult(400, err.message, 'INVALID_ARGUMENT');
    throw err;
  }
  const headers = new Headers({ authorization: cx.authorization, accept: 'application/json' });
  if (cx.clientIp) headers.set('cf-connecting-ip', cx.clientIp);
  if (built.body !== undefined) headers.set('content-type', 'application/json');
  const request = new Request(new URL(requestTarget(built), cx.origin), {
    method: built.method,
    headers,
    ...(built.body !== undefined ? { body: JSON.stringify(built.body) } : {}),
  });
  let res: Response;
  try {
    res = await cx.dispatch(request);
  } catch (err) {
    console.error(JSON.stringify({ mcpToolFailed: { tool: op.name, error: String(err) } }));
    return errorResult(500, 'internal error while running the tool; retry', 'INTERNAL');
  }
  const body = await res.text();
  let parsed: unknown = body;
  try {
    parsed = JSON.parse(body);
  } catch {
    // non-JSON body (e.g. a plain-text error)
  }
  if (res.ok) return { content: text(parsed) };
  const fields = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { error: body };
  return { isError: true, content: text({ status: res.status, ...fields }) };
}

function buildServer(cx: CallContext): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    capabilities: { tools: {} },
    jsonSchemaValidator: NO_SCHEMA_VALIDATOR,
    instructions:
      'Veyr-9 forge tools. Each tool maps onto one REST endpoint under /api/v1 with the same permissions, ' +
      'errors and cost. Failures come back as isError results with {status, error, code}.',
  });
  const all = inputShapes();
  for (const op of OPERATIONS) {
    server.registerTool(
      op.name,
      {
        description: op.description,
        inputSchema: all.get(op.name)!,
        annotations: {
          readOnlyHint: op.readOnly,
          destructiveHint: op.destructive === true,
          idempotentHint: op.readOnly || op.method === 'PUT' || op.method === 'DELETE',
          openWorldHint: false,
        },
      },
      (args: Record<string, unknown>) => callOperation(op, args, cx),
    );
  }
  return server;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized', code: 'UNAUTHENTICATED' }), {
    status: 401,
    headers: { ...JSON_HEADERS, 'www-authenticate': 'Bearer realm="forge"' },
  });
}

function insufficientScope(): Response {
  return new Response(JSON.stringify({ error: 'the token needs the api scope', code: 'INSUFFICIENT_SCOPE' }), {
    status: 403,
    headers: JSON_HEADERS,
  });
}

function rateLimited(): Response {
  return new Response(JSON.stringify({ error: 'rate limited', code: 'RATE_LIMITED' }), {
    status: 429,
    headers: { ...JSON_HEADERS, 'retry-after': '60' },
  });
}

const jsonRpcError = (status: number, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), { status, headers: JSON_HEADERS });

/** A request whose every message is a tools/call (the deferred-verification path). */
function onlyToolCalls(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.length > 0 && msgs.every((m) => m && typeof m === 'object' && (m as { method?: unknown }).method === 'tools/call');
}

/** The principal check applied to a verified token: api scope required. */
function principalResponse(pat: PATInfo | null): Response | null {
  if (!pat) return unauthorized();
  if (!scopesAllow(pat.scopes, 'api')) return insufficientScope();
  return null;
}

export async function handleMcp(request: Request, env: Env, dispatch: Dispatch): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed; POST JSON-RPC to /mcp', code: 'METHOD_NOT_ALLOWED' }), {
      status: 405,
      headers: { ...JSON_HEADERS, allow: 'POST' },
    });
  }
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token || !tokenKind(token)) return unauthorized();
  const clientIp = request.headers.get('cf-connecting-ip');
  const hash = await patHash(token);
  if ((await readPatCache(hash, Date.now())) === 'invalid') return unauthorized();

  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return jsonRpcError(413, -32600, 'request body too large');
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return jsonRpcError(413, -32600, 'request body too large');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonRpcError(400, -32700, 'Parse error: invalid JSON');
  }

  const deferred = onlyToolCalls(body);
  if (!deferred) {
    const who = await resolvePAT(env, token, clientIp);
    if (!who.ok) return who.status === 429 ? rateLimited() : unauthorized();
    const denied = principalResponse(who.pat);
    if (denied) return denied;
  }

  const observed: Array<PATInfo | null> = [];
  const cx: CallContext = { origin: new URL(request.url).origin, authorization: `Bearer ${token}`, clientIp, dispatch };
  const run = async (): Promise<Response> => {
    const server = buildServer(cx);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const replay = new Request(request.url, { method: 'POST', headers: request.headers });
      return await transport.handleRequest(replay, { parsedBody: body });
    } finally {
      await server.close().catch(() => undefined);
    }
  };
  let res: Response;
  try {
    res = deferred ? await observePrincipals((pat) => observed.push(pat), run) : await run();
  } catch (err) {
    console.error(JSON.stringify({ mcpRequestFailed: String(err) }));
    return jsonRpcError(500, -32603, 'internal error');
  }

  if (deferred) {
    // The REST routes verified the token; a call that never reached one
    // (invalid arguments, unknown tool) is verified here instead.
    let verdict: Response | null;
    if (observed.length > 0) {
      verdict = observed.map(principalResponse).find((r) => r !== null) ?? null;
    } else {
      const who = await resolvePAT(env, token, clientIp);
      verdict = who.ok ? principalResponse(who.pat) : who.status === 429 ? rateLimited() : unauthorized();
    }
    if (verdict) return verdict;
  }
  return res;
}
