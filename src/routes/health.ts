import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createDb } from '../db/index.js';
import { env } from '../config/env.js';

export const healthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/health',
    {
      schema: {
        description: 'Service health status and database connectivity check',
        tags: ['System'],
        response: {
          200: z.object({
            status: z.literal('ok'),
            timestamp: z.string(),
            uptime: z.number(),
            tenantId: z.string(),
            database: z.string()
          }),
          503: z.object({
            status: z.literal('error'),
            timestamp: z.string(),
            error: z.string()
          })
        }
      }
    },
    async (request, reply) => {
      let dbStatus = 'disconnected';
      try {
        const { client } = createDb(env.DATABASE_URL);
        await client`SELECT 1`;
        await client.end();
        dbStatus = 'connected';
      } catch (err: any) {
        dbStatus = `unavailable (${err?.message || 'connection failed'})`;
      }

      return reply.send({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        tenantId: request.tenantId,
        database: dbStatus
      });
    }
  );
};
