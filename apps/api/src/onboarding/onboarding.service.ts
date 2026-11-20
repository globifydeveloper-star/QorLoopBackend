import { Inject, Injectable } from '@nestjs/common';
import { emptyOnboardingProgress, onboardingChecklist, onboardingProgress } from '../../../../packages/core/src/onboarding.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import { enabledMarketplaceIds } from '../pricing/pricing.data.js';

@Injectable()
export class OnboardingService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /**
   * The ADR 015 wizard fields (unchanged; Owner and Admin only) plus the guided checklist and the essentials gate
   * (plan step 10): every role gets `essentials`, the checklist is filtered by role.
   */
  get(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'settings.view' }, async (data, p) => {
      const facts = await data.onboarding.facts();
      const wizard = p.member.role === 'owner' || p.member.role === 'admin' ? onboardingProgress(facts) : emptyOnboardingProgress();
      return { ...wizard, ...onboardingChecklist(await data.onboarding.checklistFacts(facts, p.user.id), p.member.role) };
    });
  }

  /**
   * The final setup summary (plan step 11), also reachable later: products loaded, products matched per enabled
   * marketplace and the problems found, from the stored comparison (same reference as the Dashboard's default).
   */
  summary(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'recon.view' }, async data => {
      const reference = (await data.pricing.settings())?.compareReferenceDefault === 'erp' ? 'erp' as const : 'marketplace' as const;
      const [counts, rows, enabled, stockConflicts] = await Promise.all([
        data.onboarding.setupSummary(), data.recon.summaries(reference), enabledMarketplaceIds(data), data.stock.conflictCount(),
      ]);
      const marketplaces = enabled.map(marketplaceId => {
        const r = rows.find(x => x.marketplaceId === marketplaceId);
        return {
          marketplaceId, hasData: r?.hasData ?? false, lastUploadAt: r?.lastUploadAt ?? null, stale: r?.stale ?? false,
          compared: r?.total ?? 0, matched: r?.listed ?? 0, notListed: r?.notListed ?? 0, missingFromErp: r?.missingFromErp ?? 0,
          newProducts: r?.newCount ?? 0, priceMismatches: r?.price ?? 0, stockMismatches: r?.stock ?? 0,
        };
      });
      const sum = (key: 'priceMismatches' | 'stockMismatches' | 'notListed' | 'missingFromErp') => marketplaces.reduce((n, m) => n + m[key], 0);
      const computedAt = rows.reduce<Date | null>((at, r) => (r.computedAt && (!at || r.computedAt > at) ? r.computedAt : at), null);
      // The ERP file and the enabled marketplaces' files only: a switched-off marketplace is not part of the store's setup.
      const uploads = counts.uploads.filter(u => u.source === 'erp' || (enabled as string[]).includes(u.source));
      return {
        reference, computedAt, products: counts.products, marketplaces, uploads,
        problems: {
          priceMismatches: sum('priceMismatches'), stockMismatches: sum('stockMismatches'), notListed: sum('notListed'), missingFromErp: sum('missingFromErp'),
          stockConflicts, uploadRowErrors: uploads.reduce((n, u) => n + u.rowErrors, 0),
        },
      };
    });
  }
}
