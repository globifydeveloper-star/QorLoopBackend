import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { resolveTenant, type TenantContext } from '../config/tenant.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    tenantContext: TenantContext;
  }
}

const tenantPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('tenantId', '');
  fastify.decorateRequest('tenantContext', null as any);

  fastify.addHook('onRequest', async (req) => {
    const ctx = resolveTenant(req);
    req.tenantId = ctx.tenantId;
    req.tenantContext = ctx;
  });
};

export default fp(tenantPlugin, {
  name: 'tenant-plugin'
});
