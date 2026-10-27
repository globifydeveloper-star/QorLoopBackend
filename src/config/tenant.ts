import type { FastifyRequest } from 'fastify';
import { env } from './env.js';

export interface TenantContext {
  tenantId: string;
  subdomain?: string;
}

export function resolveTenant(req: FastifyRequest): TenantContext {
  const host = req.headers.host || '';
  const parts = host.split('.');
  const subdomain = parts.length > 2 ? parts[0] : undefined;

  return {
    tenantId: env.TENANT_ID,
    subdomain
  };
}
