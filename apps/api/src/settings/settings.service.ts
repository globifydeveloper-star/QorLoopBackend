import { createHash } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { updateTenantSettings } from '../../../../packages/shared/src/contracts.js';
import type { TenantData } from '../../../../packages/db/src/database.js';
import { DEFAULT_TENANT_SETTINGS, MARKETPLACES } from '../../../../packages/core/src/constants.js';
import { enabledMarketplaces } from '../../../../packages/core/src/recon/compute.js';
import type { ReconQueue } from '../../../../packages/shared/src/recon.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import { PricingService, settingsView } from '../pricing/pricing.service.js';
import { loadPricing } from '../pricing/pricing.data.js';
import { RECON_QUEUE } from '../tokens.js';

async function view(data: TenantData) {
  const [tenant, pricing] = await Promise.all([data.tenant(), loadPricing(data)]);
  const s = tenant.settings;
  const values = {
    profile: { name: tenant.name }, timeZone: 'Asia/Qatar' as const, currency: 'QAR' as const,
    thresholds: { priceTolerance: s?.priceTolerance.toNumber() ?? 0, stockThreshold: s?.stockThreshold ?? 0, staleHours: s?.staleHours ?? 12 },
    security: { mfaRequiredForAll: s?.mfaRequiredForAll ?? false, analystCanExport: s?.analystCanExport ?? true },
    pricing: settingsView(pricing),
  };
  const revision = createHash('sha256').update(JSON.stringify([tenant.updatedAt, values])).digest('hex');
  return { ...values, revision };
}

@Injectable()
export class SettingsService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(RECON_QUEUE) private readonly recon: ReconQueue) {}
  get(ctx: RequestContext) { return this.auth.authenticated(ctx, { permission: 'settings.view' }, data => view(data)); }
  async put(ctx: RequestContext, input: z.infer<typeof updateTenantSettings>) {
    const { result, recompute } = await this.auth.authenticated(ctx, { permission: 'settings.edit', mutation: true }, async (data, p) => {
      if (input.security?.mfaRequiredForAll !== undefined && p.member.role !== 'owner') throw new ForbiddenException('Only Owners can change MFA policy');
      const before = await view(data);
      if (before.revision !== input.expectedRevision) throw new ConflictException('Settings changed; reload them and try again');
      let changed = false, recompute = false;
      if (input.profile && input.profile.name !== before.profile.name) {
        await data.settings.profile(input.profile.name);
        await data.event('settings.changed', p.user.id, null, ctx.requestId, { field: 'profile.name', old: before.profile.name, new: input.profile.name });
        changed = true;
      }
      const next = { ...DEFAULT_TENANT_SETTINGS, ...before.thresholds, ...before.security, ...input.thresholds, ...input.security };
      for (const group of ['thresholds', 'security'] as const) {
        const values = input[group];
        if (!values) continue;
        for (const field of Object.keys(values) as (keyof typeof next)[]) {
          const old = { ...before.thresholds, ...before.security }[field];
          if (old === next[field]) continue;
          await data.event('settings.changed', p.user.id, null, ctx.requestId, { field, old, new: next[field] });
          changed = true;
          if (field === 'priceTolerance' || field === 'stockThreshold') recompute = true;
        }
      }
      if (input.thresholds || input.security) await data.settings.save(next);
      if (input.pricing) {
        const applied = await this.pricing.writeSettings(data, p.user.id, ctx.requestId, input.pricing);
        changed ||= applied.changed;
        recompute ||= applied.changed;
      }
      if (changed) await data.settings.touch();
      return { result: await view(data), recompute };
    });
    if (recompute) await this.recon.enqueueRecon(ctx.tenantId, 'settings.changed');
    return result;
  }
  marketplaces(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'settings.view' }, async data => {
      const [switches, applied] = await Promise.all([data.recon.marketplaceSwitches(), data.recon.lastApplied()]);
      const now = Date.now();
      return { items: enabledMarketplaces(MARKETPLACES, switches, new Set(applied.keys())).map(m => ({
        marketplaceId: m.marketplaceId, enabled: true, hasData: m.hasData,
        lastUploadAt: applied.get(m.marketplaceId) ?? null,
        ageHours: applied.has(m.marketplaceId) ? Math.max(0, (now - applied.get(m.marketplaceId)!.getTime()) / 3600000) : null,
      })) };
    });
  }
}
