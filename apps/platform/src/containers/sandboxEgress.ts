import { WorkerEntrypoint } from 'cloudflare:workers';
import { isAllowedEgressHost } from './fleetJob';
import { sandboxProvider } from '../services/sandboxes/provider';
import { dispatchPlatformRequest } from '../index';

interface EgressProps {
  mode: 'build' | 'sandbox';
  environmentId?: string;
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
    let environmentId = props.environmentId;
    let credential: string | null = null;
    if (props.mode === 'sandbox' && props.sandboxId) {
      const sandbox = await this.env.DB.prepare('SELECT environment_id FROM sandboxes WHERE id = ?1')
        .bind(props.sandboxId)
        .first<{ environment_id: string }>();
      if (!sandbox) return denied(target.host);
      environmentId = sandbox.environment_id;
      credential = await sandboxProvider('linux')?.agentSandbox(this.env, props.sandboxId).egressCredential() ?? null;
    }
    if (!environmentId) return denied(target.host);
    const environment = await this.env.DB.prepare('SELECT allowed_hosts FROM environments WHERE id = ?1 AND archived_at IS NULL')
      .bind(environmentId)
      .first<{ allowed_hosts: string }>();
    if (!environment) return denied(target.host);
    let allowedHosts: string[] = [];
    try {
      const value: unknown = JSON.parse(environment.allowed_hosts);
      if (Array.isArray(value)) allowedHosts = value.filter((host): host is string => typeof host === 'string');
    } catch {
      return denied(target.host);
    }
    if (target.origin === appOrigin.origin) {
      const headers = new Headers(request.headers);
      headers.delete('authorization');
      if (credential) headers.set('authorization', `Basic ${btoa(`kvarm:${credential}`)}`);
      return dispatchPlatformRequest(new Request(request, { headers }), this.env, this.ctx);
    }
    if (target.host.toLowerCase() === appOrigin.host.toLowerCase()) return denied(target.host);
    if (!isAllowedEgressHost(target.host, allowedHosts, this.env.APP_ORIGIN)) return denied(target.host);
    return fetch(request);
  }
}
