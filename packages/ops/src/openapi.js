// @ts-check
/**
 * OpenAPI 3.1 description of the REST API, derived from the operation
 * registry so the contract agents read cannot drift from the routes the CLI
 * and MCP tools call. Pure: the Worker serves it at /openapi.json.
 */

import { API_PREFIX, OPERATIONS } from './index.js';

/**
 * @typedef {import('./index.js').Operation} Operation
 * @typedef {import('./index.js').Param} Param
 */

/**
 * @param {Param} p
 * @returns {Record<string, unknown>}
 */
function schemaOf(p) {
  switch (p.type) {
    case 'integer':
      return { type: 'integer' };
    case 'boolean':
      return { type: 'boolean' };
    case 'string[]':
      return { type: 'array', items: { type: 'string' } };
    case 'json':
      return {};
    default:
      return p.enum ? { type: 'string', enum: [...p.enum] } : { type: 'string' };
  }
}

/**
 * The registry writes a repository as one `{repo}` placeholder that expands to
 * two path segments; OpenAPI path parameters cannot hold a slash, so it becomes
 * `{owner}/{name}`.
 *
 * @param {Operation} op
 */
function pathAndParams(op) {
  let path = op.path;
  /** @type {Record<string, unknown>[]} */
  const parameters = [];
  for (const p of op.params) {
    if (p.in === 'path' && p.format === 'repo') {
      path = path.replace(`{${p.name}}`, '{owner}/{name}');
      parameters.push(
        { name: 'owner', in: 'path', required: true, description: 'Repository owner (user or organization login)', schema: { type: 'string' } },
        { name: 'name', in: 'path', required: true, description: 'Repository name', schema: { type: 'string' } },
      );
    } else if (p.in === 'path') {
      parameters.push({ name: p.name, in: 'path', required: true, description: p.description, schema: schemaOf(p) });
    } else if (p.in === 'query') {
      const schema = schemaOf(p);
      parameters.push({
        name: p.name,
        in: 'query',
        required: Boolean(p.required),
        description: p.description,
        // Lists go on the wire comma-joined, or as one repeated parameter per item when `literal`.
        ...(p.type === 'string[]' ? { style: 'form', explode: Boolean(p.literal) } : {}),
        schema,
      });
    }
  }
  return { path: `${API_PREFIX}${path}`, parameters };
}

/**
 * @param {Operation} op
 * @returns {Record<string, unknown> | undefined}
 */
function requestBody(op) {
  const body = op.params.filter((p) => p.in === 'body');
  if (body.length === 0) return undefined;
  /** @type {Record<string, unknown>} */
  const properties = {};
  for (const p of body) properties[p.name] = { ...schemaOf(p), description: p.description };
  const required = body.filter((p) => p.required).map((p) => p.name);
  return {
    required: required.length > 0,
    content: {
      'application/json': {
        schema: { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) },
      },
    },
  };
}

const ERROR_RESPONSE = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };

/**
 * @param {{ origin: string, title?: string, version?: string }} opts
 * @returns {Record<string, any>}
 */
export function openApiDocument({ origin, title = 'Kvarm REST API', version = '1' }) {
  /** @type {Record<string, Record<string, unknown>>} */
  const paths = {};
  for (const op of OPERATIONS) {
    const { path, parameters } = pathAndParams(op);
    const method = op.method.toLowerCase();
    const item = (paths[path] ??= {});
    // Two registry entries on one route (an MCP alias) describe one operation.
    if (item[method]) continue;
    const body = requestBody(op);
    item[method] = {
      operationId: op.name,
      summary: op.description,
      tags: [op.family],
      ...(parameters.length ? { parameters } : {}),
      ...(body ? { requestBody: body } : {}),
      responses: {
        '2XX': { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } },
        '400': ERROR_RESPONSE,
        '401': ERROR_RESPONSE,
        '403': ERROR_RESPONSE,
        '404': ERROR_RESPONSE,
        '409': ERROR_RESPONSE,
        '422': ERROR_RESPONSE,
        '429': { ...ERROR_RESPONSE, headers: { 'Retry-After': { schema: { type: 'integer' } } } },
      },
      'x-kvarm-cli': `kvarm ${op.command.join(' ')}`,
      'x-mcp-tool': op.name,
      'x-read-only': op.readOnly,
      ...(op.destructive ? { 'x-destructive': true } : {}),
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title,
      version,
      description:
        'Every operation is also an MCP tool on /mcp (named by operationId) and a `kvarm` CLI command. ' +
        'Authenticate with a personal access token (kvarm_pat_…) or a repository-scoped agent token (kvarm_agt_…) ' +
        'as `Authorization: Bearer <token>`; see /auth.md. Errors are `{"error": "...", "code": "..."}`. ' +
        'Every response carries an x-kvarm-cost work counter.',
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Agent guide', url: `${origin}/llms.txt` },
    security: [{ bearer: [] }, {}],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'kvarm_pat_… personal access token or kvarm_agt_… agent token' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' }, code: { type: 'string' } },
        },
      },
    },
    paths,
  };
}
