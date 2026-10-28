import type { FastifyRequest } from 'fastify';
import { env } from './env.js';

export interface TenantContext {
  tenantId: string;
  subdomain?: string;
}

export function resolveTenant(req: FastifyRequest): TenantContext {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  let subdomain: string | undefined;

  if (host.endsWith(env.BASE_DOMAIN)) {
    const prefix = host.slice(0, -env.BASE_DOMAIN.length).replace(/\.$/, '');
    if (prefix) {
      subdomain = prefix;
    }
  } else if (host.endsWith('localhost')) {
    const parts = host.split('.');
    if (parts.length > 1 && parts[0] !== 'localhost') {
      subdomain = parts[0];
    }
  }

  return {
    tenantId: env.TENANT_ID,
    subdomain
  };
}
