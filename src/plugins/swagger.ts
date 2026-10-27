import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

const swaggerPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Qorloop API',
        description: 'Qorloop multi-tenant ERP & Marketplace reconciliation platform API',
        version: '0.1.0'
      },
      servers: [
        {
          url: 'http://localhost:4000',
          description: 'Local development server'
        }
      ]
    },
    transform: jsonSchemaTransform
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false
    }
  });
};

export default fp(swaggerPlugin, {
  name: 'swagger-plugin'
});
