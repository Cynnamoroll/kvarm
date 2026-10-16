import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} target @param {{ path?: string, authorization?: string | null, onResponse?: (response: import('node:http').IncomingMessage) => void }} [options] */
export function forwardGitRequest(req, res, target, options = {}) {
  const url = new URL(options.path ?? req.url ?? '/', target);
  const headers = { ...req.headers, host: url.host };
  if (options.authorization === null) delete headers.authorization;
  else if (options.authorization !== undefined) headers.authorization = options.authorization;
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = request(url, { method: req.method, headers }, (response) => {
    options.onResponse?.(response);
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
  return upstream;
}
