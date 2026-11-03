import type { Prisma } from './generated/client.js';
import { MARKETPLACES } from '../../core/src/constants.js';
import type { OnboardingEvidence, OnboardingFacts } from '../../core/src/onboarding.js';

const evidence = (at: Date | null | undefined): OnboardingEvidence => ({ done: at != null, doneAt: at?.toISOString() ?? null });

/** Fixed-size probes: no product, listing, recon-row or audit-history reads. Every probe is tenant-scoped. */
export class OnboardingRepository {
  constructor(private readonly tenantId: string, private readonly tx: Prisma.TransactionClient) {}

  async facts(): Promise<OnboardingFacts> {
    const tenantId = this.tenantId;
    const [owner, erp, marketplaceUploads, comparison, invitation, pricing, marketplaceRule, generated] = await Promise.all([
      // Select only membership ID, never MFA ciphertext. An active enrolled Owner is sufficient.
      this.tx.membership.findFirst({ where: { tenantId, role: 'owner', active: true, user: { tenantId, mfaSecret: { not: null } } }, select: { id: true } }),
      this.tx.upload.findFirst({ where: { tenantId, source: 'erp', status: 'applied', appliedAt: { not: null } }, select: { appliedAt: true } }),
      Promise.all(MARKETPLACES.map(async marketplaceId => {
        const row = await this.tx.upload.findFirst({ where: { tenantId, source: marketplaceId, status: 'applied', appliedAt: { not: null } }, select: { appliedAt: true } });
        return { marketplaceId, appliedAt: row?.appliedAt?.toISOString() ?? null };
      })),
      this.tx.reconSummary.findFirst({ where: { tenantId, hasData: true, listed: { gt: 0 }, computedAt: { not: null } }, select: { computedAt: true } }),
      // Operations' initial Owner invitation has no inviter. Historical invitations count even if expired/revoked.
      this.tx.invitation.findFirst({ where: { tenantId, invitedBy: { not: null } }, select: { createdAt: true } }),
      this.tx.pricingSettings.findFirst({ where: { tenantId, OR: [
        { defaultRuleMode: { not: 'same' } }, { defaultRuleValue: { not: 0 } }, { rounding: { not: 'exact' } },
        { perMarketplaceEnabled: true }, { compareReferenceDefault: { not: 'marketplace' } },
      ] }, select: { updatedAt: true } }),
      // The default has no tenant-level marketplace rules. Product/category rules are outside this step.
      this.tx.marketplacePriceRule.findFirst({ where: { tenantId, productId: null }, select: { updatedAt: true } }),
      this.tx.generatedFile.findFirst({ where: { tenantId }, select: { generatedAt: true } }),
    ]);
    return {
      // No dedicated enrollment timestamp exists. Do not guess from User.updatedAt or scan audit history.
      ownerMfa: { done: owner !== null, doneAt: null },
      erpUpload: evidence(erp?.appliedAt), marketplaces: marketplaceUploads,
      comparison: evidence(comparison?.computedAt), teamInvitation: evidence(invitation?.createdAt),
      pricingSettings: evidence(pricing?.updatedAt ?? marketplaceRule?.updatedAt), generatedFile: evidence(generated?.generatedAt),
    };
  }
}
