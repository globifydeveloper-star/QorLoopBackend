import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { Database } from '../../../../packages/db/src/database.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import type { Permission } from '../../../../packages/core/src/roles.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type { StepUpWindow } from '../../../../packages/shared/src/otp.js';
import { CONFIG } from '../tokens.js';

/**
 * stepUp: the action needs a fresh second factor inside the session (ADR 021). 'security' 10 minutes, 'work' 30
 * minutes, 'single' 10 minutes and consumed by the action itself (the guard only checks it).
 */
type Policy = { public?: boolean; partial?: boolean; skipTenant?: boolean; permission?: Permission; stepUp?: StepUpWindow };
export const Access = (policy: Policy) => SetMetadata('access', policy);
export type AppRequest = FastifyRequest & { tenantId: string };

export function cookieName(config: Config) { return config.NODE_ENV === 'production' ? '__Host-qorloop' : 'qorloop'; }
/** The trusted-device cookie (90 days) and the sign-in challenge cookie (10 minutes), next to the session cookie. */
export const deviceCookieName = (config: Config) => cookieName(config) + '.device';
export const challengeCookieName = (config: Config) => cookieName(config) + '.challenge';
export function context(req: AppRequest, config: Config): RequestContext {
  const header = (name: string) => typeof req.headers[name] === 'string' ? req.headers[name] as string : undefined;
  return {
    tenantId: req.tenantId, requestId: req.id, token: req.cookies[cookieName(config)], csrf: header('x-csrf-token'),
    deviceToken: req.cookies[deviceCookieName(config)], challengeToken: req.cookies[challengeCookieName(config)], userAgent: header('user-agent'),
  };
}
/**
 * The configured instance pin, applied only in production: each production stack serves one pinned store (ADR 005).
 * Development and test resolve every active store by its exact hostname, so a second local store works without
 * editing TENANT_ID.
 */
export function tenantPin(config: Pick<Config, 'NODE_ENV' | 'TENANT_ID'>): string | undefined {
  return config.NODE_ENV === 'production' ? config.TENANT_ID : undefined;
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
    const tenant = await this.db.resolve(hostname(req.headers.host), tenantPin(this.config));
    if (!tenant) throw new NotFoundException('Store not found');
    req.tenantId = tenant.id;
    if (!policy.public) {
      await this.auth.authenticated(context(req, this.config), {
        partial: policy.partial, permission: policy.permission, mutation: !['GET', 'HEAD', 'OPTIONS'].includes(req.method),
        // A single-use step-up is consumed by the action's own transaction, not here.
        stepUp: policy.stepUp === 'single' ? 'security' : policy.stepUp,
      }, async () => true);
    }
    return true;
  }
}

