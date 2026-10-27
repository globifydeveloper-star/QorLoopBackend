import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { env } from './config/env.js';
import tenantPlugin from './plugins/tenant.js';
import swaggerPlugin from './plugins/swagger.js';
import { healthRoutes } from './routes/health.js';
import { apiRoutes } from './routes/api/index.js';

export async function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV === 'development' ? {
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname'
        }
      }
    } : true
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    contentSecurityPolicy: false
  });

  await app.register(cors, {
    origin: [env.CORS_ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
  });

  await app.register(sensible);
  await app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024 // 25 MB file limit
    }
  });

  await app.register(tenantPlugin);
  await app.register(swaggerPlugin);

  await app.register(healthRoutes);
  await app.register(apiRoutes, { prefix: '/api' });

  return app;
}
