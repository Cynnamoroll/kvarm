import { WorkerEntrypoint } from 'cloudflare:workers';
import { isAllowedEgressHost } from './fleetJob';
import { sandboxProvider } from '../services/sandboxes/provider';
import { dispatchPlatformRequest } from '../index';

interface EgressProps {
  mode: 'build' | 'sandbox';
  environmentId: string;
  allowedHosts: string[];
  sandboxId?: string;
}

function denied(host: string): Response {
  return new Response(`kvarm sandbox egress denied: ${host}`, {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export class SandboxEgress extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    const target = new URL(request.url);
    let appOrigin: URL;
    try {
      appOrigin = new URL(this.env.APP_ORIGIN);
    } catch {
      return denied(target.host);
    }
    const props = this.ctx.props;
    if (target.origin === appOrigin.origin) {
      const headers = new Headers(request.headers);
      headers.delete('authorization');
      const credential =
        props.mode === 'sandbox' && props.sandboxId
          ? await sandboxProvider('linux')?.agentSandbox(this.env, props.sandboxId).egressCredential() ?? null
          : null;
      if (credential) headers.set('authorization', `Basic ${btoa(`kvarm:${credential}`)}`);
      return dispatchPlatformRequest(new Request(request, { headers }), this.env, this.ctx);
    }
    if (target.host.toLowerCase() === appOrigin.host.toLowerCase()) return denied(target.host);
    if (!isAllowedEgressHost(target.host, props.allowedHosts, this.env.APP_ORIGIN)) return denied(target.host);
    return fetch(request);
  }
}
