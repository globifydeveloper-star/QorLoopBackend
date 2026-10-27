import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLE_PERMISSIONS, type Role } from '../../core/roles.js';

export const apiRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/me',
    {
      schema: {
        description: 'Get current authenticated user, role, permissions, and tenant context',
        tags: ['Session'],
        response: {
          200: z.object({
            user: z.object({
              id: z.string(),
              email: z.string(),
              name: z.string()
            }),
            role: z.string(),
            permissions: z.array(z.string()),
            tenant: z.object({
              id: z.string(),
              name: z.string(),
              subdomain: z.string(),
              onboardingStep: z.string()
            })
          })
        }
      }
    },
    async (request, reply) => {
      const role: Role = 'owner';
      return reply.send({
        user: {
          id: 'dev-owner-id',
          email: 'admin@dohafresh.qa',
          name: 'Doha Fresh Admin'
        },
        role,
        permissions: ROLE_PERMISSIONS[role],
        tenant: {
          id: request.tenantId,
          name: 'Doha Fresh Markets',
          subdomain: 'dohafresh',
          onboardingStep: 'welcome'
        }
      });
    }
  );
};
