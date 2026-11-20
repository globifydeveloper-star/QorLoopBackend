import type { Prisma } from './generated/client.js';
import { MARKETPLACES } from '../../core/src/constants.js';
import { enabledMarketplaces } from '../../core/src/recon/compute.js';
import type { ChecklistFacts, OnboardingEvidence, OnboardingFacts, PendingUpload } from '../../core/src/onboarding.js';

const evidence = (at: Date | null | undefined): OnboardingEvidence => ({ done: at != null, doneAt: at?.toISOString() ?? null });
/** Upload statuses that leave a file unfinished: still in progress, or refused and waiting for a corrected file. */
const UNFINISHED = ['uploading', 'uploaded', 'processing', 'needs_mapping', 'needs_review', 'applying', 'rejected', 'failed'];

/** Fixed-size probes: no product, listing or recon-row reads. Every probe is tenant-scoped. */
export class OnboardingRepository {
  constructor(private readonly tenantId: string, private readonly tx: Prisma.TransactionClient) {}

  async facts(): Promise<OnboardingFacts> {
    const tenantId = this.tenantId;
    const [owner, erp, marketplaceUploads, comparison, invitation, pricing, marketplaceRule, generated] = await Promise.all([
      // Since ADR 021 every sign-in on a new device needs a second factor (an emailed code, or the authenticator app),
      // so an active Owner has secured the account; the app itself is optional.
      this.tx.membership.findFirst({ where: { tenantId, role: 'owner', active: true }, select: { id: true } }),
      // Ordered, so doneAt is the earliest retained evidence and stable between calls (plan finding B6).
      this.tx.upload.findFirst({ where: { tenantId, source: 'erp', status: 'applied', appliedAt: { not: null } }, select: { appliedAt: true }, orderBy: { appliedAt: 'asc' } }),
      Promise.all(MARKETPLACES.map(async marketplaceId => {
        const row = await this.tx.upload.findFirst({ where: { tenantId, source: marketplaceId, status: 'applied', appliedAt: { not: null } }, select: { appliedAt: true }, orderBy: { appliedAt: 'asc' } });
        return { marketplaceId, appliedAt: row?.appliedAt?.toISOString() ?? null };
      })),
      this.tx.reconSummary.findFirst({ where: { tenantId, hasData: true, listed: { gt: 0 }, computedAt: { not: null } }, select: { computedAt: true } }),
      // Operations' initial Owner invitation has no inviter. Historical invitations count even if expired/revoked.
      this.tx.invitation.findFirst({ where: { tenantId, invitedBy: { not: null } }, select: { createdAt: true }, orderBy: { createdAt: 'asc' } }),
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

  /**
   * The setup summary's own counts (GET /api/onboarding/summary): products in the catalogue, and the newest applied
   * file per source with its stored row errors. Called once when the summary is opened, not on every checklist read.
   */
  async setupSummary() {
    const tenantId = this.tenantId;
    const sources = ['erp', ...MARKETPLACES] as const;
    const [loaded, active, blocked, latest] = await Promise.all([
      this.tx.product.count({ where: { tenantId } }),
      this.tx.product.count({ where: { tenantId, status: 'active', blockedAt: null } }),
      this.tx.product.count({ where: { tenantId, blockedAt: { not: null } } }),
      Promise.all(sources.map(source => this.tx.upload.findFirst({
        where: { tenantId, source, status: 'applied', appliedAt: { not: null } }, orderBy: { appliedAt: 'desc' }, select: { id: true, appliedAt: true },
      }))),
    ]);
    const errors = await Promise.all(latest.map(u => u ? this.tx.uploadError.count({ where: { tenantId, uploadId: u.id } }) : Promise.resolve(0)));
    return {
      products: { loaded, active, blocked },
      uploads: sources.map((source, i) => ({ source, uploadId: latest[i]?.id ?? null, appliedAt: latest[i]?.appliedAt ?? null, rowErrors: errors[i]! })),
    };
  }

  /**
   * The checklist's further evidence, on top of `facts()`: switches, the newest unfinished upload per source, the
   * price-source choice, a recon failure newer than the last computation (only while no comparison exists, so the audit
   * read stays within a new store's short history), thresholds and the viewer's own authenticator app.
   */
  async checklistFacts(base: OnboardingFacts, viewerId: string): Promise<ChecklistFacts> {
    const tenantId = this.tenantId;
    const newestUnfinished = async (source: string): Promise<PendingUpload | null> => {
      const row = await this.tx.upload.findFirst({ where: { tenantId, source, status: { not: 'discarded' } }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, updatedAt: true } });
      return row && UNFINISHED.includes(row.status) ? { id: row.id, status: row.status, updatedAt: row.updatedAt.toISOString() } : null;
    };
    const [switches, pending, priceSource, lastComputed, settings, viewer] = await Promise.all([
      this.tx.tenantMarketplace.findMany({ where: { tenantId }, select: { marketplaceId: true, enabled: true } }),
      Promise.all(['erp', ...MARKETPLACES].map(newestUnfinished)),
      this.tx.pricingSettings.findUnique({ where: { tenantId }, select: { priceSource: true, priceSourceMarketplaceId: true, priceSourceConfirmedAt: true } }),
      this.tx.reconSummary.aggregate({ where: { tenantId }, _max: { computedAt: true } }),
      this.tx.tenantSettings.findUnique({ where: { tenantId }, select: { priceTolerance: true, stockThreshold: true, staleHours: true } }),
      this.tx.user.findFirst({ where: { tenantId, id: viewerId, mfaSecret: { not: null } }, select: { id: true } }),
    ]);
    const failure = base.comparison.done ? null : await this.tx.auditEvent.findFirst({
      where: { tenantId, action: 'recon.failed', ...(lastComputed._max.computedAt ? { createdAt: { gt: lastComputed._max.computedAt } } : {}) },
      orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    });
    const applied = new Set(base.marketplaces.filter(m => m.appliedAt).map(m => m.marketplaceId));
    const enabled = new Set(enabledMarketplaces(MARKETPLACES, switches, applied).map(m => m.marketplaceId));
    return {
      marketplaces: base.marketplaces.map((m, i) => ({
        marketplaceId: m.marketplaceId, enabled: enabled.has(m.marketplaceId), explicit: switches.some(s => s.marketplaceId === m.marketplaceId),
        appliedAt: m.appliedAt, pendingUpload: pending[i + 1]!,
      })),
      erp: { appliedAt: base.erpUpload.doneAt, pendingUpload: pending[0]! },
      priceSource: {
        source: (priceSource?.priceSource ?? null) as 'erp_markup' | 'adopt' | null,
        marketplaceId: priceSource?.priceSourceMarketplaceId ?? null, confirmedAt: priceSource?.priceSourceConfirmedAt?.toISOString() ?? null,
      },
      comparison: { doneAt: base.comparison.doneAt, lastFailureAt: failure?.createdAt.toISOString() ?? null },
      thresholds: { priceTolerance: settings?.priceTolerance.toNumber() ?? 0, stockThreshold: settings?.stockThreshold ?? 0, staleHours: settings?.staleHours ?? 12 },
      teamInvitationAt: base.teamInvitation.doneAt,
      viewerMfa: viewer !== null,
    };
  }
}
