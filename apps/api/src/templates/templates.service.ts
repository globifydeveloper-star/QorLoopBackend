import { Inject, Injectable } from '@nestjs/common';
import type { TenantData } from '../../../../packages/db/src/database.js';
import type { UploadSource } from '../../../../packages/core/src/upload/constants.js';
import {
  currentVersions, isMarketplace, layoutView, outgoingView, sourceEntry, TEMPLATE_SOURCES, type LayoutUsage,
} from '../../../../packages/core/src/upload/templates.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';

type Layout = Awaited<ReturnType<TenantData['uploads']['allMappings']>>[number];
const nameKey = (l: Pick<Layout, 'tenantId' | 'source' | 'name'>) => JSON.stringify([l.tenantId, l.source, l.name]);
const stringHeaders = (v: unknown) => (Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : null);

/**
 * One entry per source. Layouts are the newest version of each saved name; usage and the last file's headers are
 * summed over all versions of that name. Outgoing columns come from the latest applied upload, as generation reads them.
 */
export async function templateEntries(data: TenantData, only?: UploadSource) {
  const all = await data.uploads.allMappings();
  const usage = await data.uploads.layoutUsage(all.map(l => l.id));
  const current = currentVersions(all);
  const currentIds = new Set(current.map(l => l.id));
  const byId = new Map(all.map(l => [l.id, l]));
  const perName = new Map<string, LayoutUsage & { headersAt: Date | null }>();
  for (const l of all) {
    const u = usage.get(l.id);
    if (!u) continue;
    const acc = perName.get(nameKey(l)) ?? { usedByUploads: 0, lastUsedAt: null, headers: null, headersAt: null };
    acc.usedByUploads += u.count;
    if (u.lastUsedAt && (!acc.lastUsedAt || u.lastUsedAt > acc.lastUsedAt)) acc.lastUsedAt = u.lastUsedAt;
    if (u.headersAt && (!acc.headersAt || u.headersAt > acc.headersAt)) { acc.headersAt = u.headersAt; acc.headers = stringHeaders(u.headers); }
    perName.set(nameKey(l), acc);
  }
  const sources = only ? [only] : [...TEMPLATE_SOURCES];
  const applied = await Promise.all(sources.map(s => (isMarketplace(s) ? data.generatedFiles.latestApplied(s) : null)));
  const layoutOf = (id: string) => {
    const t = byId.get(id);
    return t ? { name: t.name, version: t.version, current: currentIds.has(id) } : null;
  };
  return sources.map((source, i) => {
    const layouts = current.filter(l => l.source === source).map(l => {
      const u = perName.get(nameKey(l));
      return layoutView(l, { usedByUploads: u?.usedByUploads ?? 0, lastUsedAt: u?.lastUsedAt ?? null, headers: u?.headers ?? null });
    });
    return sourceEntry(source, layouts, isMarketplace(source) ? outgoingView(source, applied[i] ?? null, layoutOf) : null);
  });
}

@Injectable()
export class TemplatesService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  list(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'settings.view' }, async data => ({ items: await templateEntries(data) }));
  }
}
