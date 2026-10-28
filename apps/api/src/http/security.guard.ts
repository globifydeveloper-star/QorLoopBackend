import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { Database } from '../../../../packages/db/src/database.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import type { Permission } from '../../../../packages/core/src/roles.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import { CONFIG } from '../tokens.js';

type Policy = { public?: boolean; partial?: boolean; skipTenant?: boolean; permission?: Permission };
export const Access = (policy: Policy) => SetMetadata('access', policy);
export type AppRequest = FastifyRequest & { tenantId: string };

export function cookieName(config: Config) { return config.NODE_ENV === 'production' ? '__Host-qorloop' : 'qorloop'; }
export function context(req: AppRequest, config: Config): RequestContext {
  return { tenantId: req.tenantId, requestId: req.id, token: req.cookies[cookieName(config)], csrf: typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined };
}
export function hostname(host?: string): string {
  if (!host || !/^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/i.test(host)) return '';
  return host.split(':')[0]!.toLowerCase();
}
export function originsForHost(config: Config, host: string) {
  return [config.APP_ORIGIN, config.CORS_ORIGIN].filter(Boolean).map(origin => {
    const url = new URL(origin!);
    url.hostname = host;
    return url.origin;
  });
}
@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(Database) private readonly db: Database,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}
  async canActivate(execution: ExecutionContext) {
    const policy = this.reflector.getAllAndOverride<Policy>('access', [execution.getHandler(), execution.getClass()]) ?? {};
    if (policy.skipTenant) return true;
    const req = execution.switchToHttp().getRequest<AppRequest>();
    const tenant = await this.db.resolve(hostname(req.headers.host), this.config.TENANT_ID);
    if (!tenant) throw new NotFoundException('Store not found');
    req.tenantId = tenant.id;
    if (!policy.public) {
      await this.auth.authenticated(context(req, this.config), {
        partial: policy.partial, permission: policy.permission, mutation: !['GET', 'HEAD', 'OPTIONS'].includes(req.method),
      }, async () => true);
    }
    return true;
  }
}

