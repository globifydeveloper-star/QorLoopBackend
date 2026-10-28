import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module, Controller, Get, Req, Inject, Catch, HttpException, ServiceUnavailableException, type ExceptionFilter, type ArgumentsHost, type NestInterceptor, type ExecutionContext, type CallHandler } from '@nestjs/common';
import { NestFactory, APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { map } from 'rxjs/operators';
import { Database } from '../../../packages/db/src/database.js';
import type { Config } from '../../../packages/shared/src/config.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { TeamController } from './team/team.controller.js';
import { TeamService } from './team/team.service.js';
import { Access, SecurityGuard, cookieName, context, hostname, originsForHost, type AppRequest } from './http/security.guard.js';
import { Contract } from './http/contracts.js';
import { CONFIG, STORAGE, UPLOAD_QUEUE } from './tokens.js';
import { UploadsController } from './uploads/uploads.controller.js';
import { UploadsService } from './uploads/uploads.service.js';
import { S3Storage, type ObjectStorage } from '../../../packages/shared/src/storage.js';
import { BullUploadQueue, type UploadQueue } from '../../../packages/shared/src/queue.js';

@Controller()
class SystemController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuthService) private readonly auth: AuthService, @Inject(CONFIG) private readonly config: Config) {}
  @Get('health') @Access({ skipTenant: true }) @Contract('Liveness; no dependency or customer details')
  live() { return { status: 'ok' }; }
  @Get('health/ready') @Access({ skipTenant: true }) @Contract('Readiness; returns 503 when PostgreSQL is unavailable')
  async ready() {
    try { await this.db.ping(); return { status: 'ok' }; }
    catch { throw new ServiceUnavailableException('Database unavailable'); }
  }
  @Get('api/me') @Access({}) @Contract('Authenticated compatibility alias for /api/auth/me')
  me(@Req() req: AppRequest) { return this.auth.me(context(req, this.config)); }
}

class EnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler) { return next.handle().pipe(map(data => ({ data }))); }
}

@Catch()
class ErrorFilter implements ExceptionFilter {
  constructor(private readonly reportErrors = false) {}
  catch(error: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<FastifyRequest>();
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    // @fastify/rate-limit throws the plain object from errorResponseBuilder (not an HttpException).
    const plain = error as { statusCode?: unknown; error?: { message?: string } } | null;
    const plainStatus = typeof plain?.statusCode === 'number' && plain.statusCode >= 400 && plain.statusCode < 500 ? plain.statusCode : undefined;
    const status = error instanceof HttpException ? error.getStatus() : plainStatus ?? 500;
    const response = error instanceof HttpException ? error.getResponse() : plainStatus ? { message: plain?.error?.message } : undefined;
    const detail = typeof response === 'object' && response !== null ? response as { message?: string | string[]; details?: unknown } : {};
    const message = status >= 500 ? (status === 503 ? 'Service unavailable' : 'Internal server error') : typeof response === 'string' ? response : detail.message ?? 'Request failed';
    if (status >= 500) {
      req.log.error({ requestId: req.id, errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
      // Raw exceptions may contain ORM arguments, tokens or mail bodies.
      if (this.reportErrors) void import('@sentry/node').then(Sentry => Sentry.captureException(new Error('Unhandled application error'), { tags: { requestId: req.id, errorType: error instanceof Error ? error.name : 'UnknownError' } }));
    }
    const codes: Record<number, string> = { 400: 'VALIDATION_ERROR', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED', 503: 'UNAVAILABLE' };
    reply.code(status).send({ error: { code: codes[status] ?? 'INTERNAL_ERROR', message, ...(status < 500 && detail.details ? { details: detail.details } : {}) }, requestId: req.id });
  }
}

export async function buildApp(config: Config, options: { database?: Database; connect?: boolean; logger?: boolean; rateLimitMax?: number; storage?: ObjectStorage; queue?: UploadQueue } = {}) {
  const database = options.database ?? new Database(config.DATABASE_URL);
  if (options.connect !== false) await database.connect();
  const storage = options.storage ?? new S3Storage({
    bucket: config.S3_BUCKET, region: config.S3_REGION, endpoint: config.S3_ENDPOINT, forcePathStyle: config.S3_FORCE_PATH_STYLE,
    accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  });
  let queueRedis: import('ioredis').Redis | undefined;
  let queue = options.queue;
  if (!queue) {
    const { Redis } = await import('ioredis');
    queueRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new BullUploadQueue(queueRedis);
  }
  @Module({
    controllers: [SystemController, AuthController, TeamController, UploadsController],
    providers: [
      { provide: Database, useValue: database }, { provide: CONFIG, useValue: config },
      AuthService, TeamService, UploadsService, { provide: STORAGE, useValue: storage }, { provide: UPLOAD_QUEUE, useValue: queue },
      { provide: APP_GUARD, useClass: SecurityGuard },
    ],
  })
  class ApiModule {}
  const adapter = new FastifyAdapter({
    bodyLimit: 32 * 1024, trustProxy: false, requestIdHeader: false, genReqId: () => randomUUID(),
    logger: options.logger === false ? false : {
      level: 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
      serializers: { req: (req: FastifyRequest) => ({ method: req.method, path: req.url?.split('?')[0], host: req.headers?.host }) },
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(ApiModule, adapter, { logger: false, abortOnError: false });
  const server = app.getHttpAdapter().getInstance();
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: config.NODE_ENV === 'production' ? undefined : false });
  let redis: import('ioredis').Redis | undefined;
  if (config.NODE_ENV === 'production') {
    const { Redis } = await import('ioredis');
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    await redis.connect();
    await redis.ping();
  }
  await app.register(rateLimit, {
    global: true, timeWindow: 60_000, skipOnError: false,
    ...(redis ? { redis } : {}),
    max: (req: FastifyRequest) => options.rateLimitMax ?? (req.url.startsWith('/api/auth/') && req.method === 'POST' ? 20 : 300),
    keyGenerator: (req: FastifyRequest) => hostname(req.headers.host) + ':' + req.ip + ':' + req.url.split('?')[0],
    errorResponseBuilder: (req: FastifyRequest) => ({ statusCode: 429, error: { code: 'RATE_LIMITED', message: 'Too many requests' }, requestId: req.id }),
  });
  server.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-ID', req.id);
    reply.header('Cache-Control', 'no-store');
    if (!req.url.startsWith('/api/')) return;
    const origin = req.headers.origin;
    const allowed = originsForHost(config, hostname(req.headers.host));
    const validOrigin = typeof origin === 'string' && allowed.includes(origin);
    if (origin && !validOrigin || !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !validOrigin) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Trusted Origin required' }, requestId: req.id });
    }
    if (validOrigin) {
      reply.header('Access-Control-Allow-Origin', origin!);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!validOrigin) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Trusted Origin required' }, requestId: req.id });
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
      return reply.code(204).send();
    }
  });
  server.addHook('onClose', async () => {
    if (redis) await redis.quit();
    if (!options.queue) { await (queue as BullUploadQueue).close(); await queueRedis?.quit(); }
    if (!options.database) await database.close();
  });
  app.useGlobalFilters(new ErrorFilter(Boolean(config.SENTRY_DSN)));
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  const spec = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Qorloop API').setDescription(
    'Invitation-only API. All mutations require a trusted Origin. Cookie-authenticated mutations also require X-CSRF-Token from login/MFA responses or the readable CSRF cookie. Host resolves the store; client tenant IDs are never accepted. Restricted MFA sessions can only enroll/verify MFA or log out.',
  ).setVersion('0.2.0').addCookieAuth(cookieName(config), { type: 'apiKey', in: 'cookie' }, 'cookie').build());
  const publicPaths = new Set(['/api/auth/invitations/accept', '/api/auth/login', '/api/auth/password/forgot', '/api/auth/password/reset', '/health', '/health/ready']);
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, value] of Object.entries(item ?? {})) {
      if (!value || typeof value !== 'object' || !('responses' in value)) continue;
      const operation = value as import('@nestjs/swagger').OpenAPIObject['paths'][string]['get'];
      if (!operation) continue;
      operation.security = publicPaths.has(path) ? [] : [{ cookie: [] }];
      if (['post', 'patch', 'delete', 'put'].includes(method)) {
        operation.parameters = [...(operation.parameters ?? []), { name: 'Origin', in: 'header', required: true, schema: { type: 'string', format: 'uri' } }];
        if (!publicPaths.has(path)) operation.parameters.push({ name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string' } });
      }
    }
  }
  SwaggerModule.setup('docs', app, spec, { jsonDocumentUrl: '/docs/openapi.json' });
  await app.init();
  await server.ready();
  return { app, server, database, spec };
}

