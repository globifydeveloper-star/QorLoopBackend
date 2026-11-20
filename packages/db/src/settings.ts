import type { Prisma } from './generated/client.js';
import { MARKETPLACES } from '../../core/src/constants.js';

type SettingsWrite = Pick<Prisma.TenantSettingsUncheckedCreateInput,
  'priceTolerance' | 'stockThreshold' | 'staleHours' | 'mfaRequiredForAll' | 'analystCanExport'>;

/** All writes run under Database.run's tenant lock; no new settings storage. */
export class SettingsRepository {
  constructor(private readonly tenantId: string, private readonly tx: Prisma.TransactionClient) {}
  save(data: SettingsWrite) {
    return this.tx.tenantSettings.upsert({ where: { tenantId: this.tenantId }, create: { tenantId: this.tenantId, ...data }, update: data });
  }
  async profile(name: string) {
    await this.tx.tenant.update({ where: { id: this.tenantId }, data: { name } });
    await this.tx.store.updateMany({ where: { tenantId: this.tenantId }, data: { name } });
  }
  /**
   * Explicit switches for every marketplace: the listed ones on, all others off. An explicit row always wins over the
   * applied-upload fallback (recon/compute.ts enabledMarketplaces), so an unused marketplace stays off after an upload.
   */
  async setMarketplaces(enabled: readonly string[]) {
    for (const marketplaceId of MARKETPLACES) {
      const on = enabled.includes(marketplaceId);
      await this.tx.tenantMarketplace.upsert({
        where: { tenantId_marketplaceId: { tenantId: this.tenantId, marketplaceId } },
        create: { tenantId: this.tenantId, marketplaceId, enabled: on }, update: { enabled: on },
      });
    }
  }
  /** An existing timestamp supplies a version even when settings are changed and changed back. */
  async touch() {
    await this.tx.$executeRaw`UPDATE tenants SET updated_at = greatest(date_trunc('milliseconds', clock_timestamp()), updated_at + interval '1 millisecond') WHERE id = ${this.tenantId}::uuid`;
  }
}
