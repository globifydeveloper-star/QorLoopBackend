import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import type { TenantData } from '../../../../packages/db/src/database.js';
import type { updateTemplate } from '../../../../packages/shared/src/contracts.js';
import type { UploadSource } from '../../../../packages/core/src/upload/constants.js';
import {
  currentVersions, isMarketplace, layoutView, outgoingView, planLayoutEdit, sourceEntry, TEMPLATE_SOURCES, type LayoutUsage,
} from '../../../../packages/core/src/upload/templates.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';

type Layout = Awaited<ReturnType<TenantData['uploads']['allMappings']>>[number];
const nameKey = (l: Pick<Layout, 'tenantId' | 'source' | 'name'>) => JSON.stringify([l.tenantId, l.source, l.name]);
const stringHeaders = (v: unknown) => (Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : null);
const STALE = 'This layout was changed by someone else; reload it and try again';

/** Usage per layout name, summed over its versions; headers are those of the newest upload that recorded them. */
async function usageByName(data: TenantData, layouts: Layout[]) {
  const usage = await data.uploads.layoutUsage(layouts.map(l => l.id));
  const perName = new Map<string, LayoutUsage & { headersAt: Date | null }>();
  for (const l of layouts) {
    const u = usage.get(l.id);
    if (!u) continue;
    const acc = perName.get(nameKey(l)) ?? { usedByUploads: 0, lastUsedAt: null, headers: null, headersAt: null };
    acc.usedByUploads += u.count;
    if (u.lastUsedAt && (!acc.lastUsedAt || u.lastUsedAt > acc.lastUsedAt)) acc.lastUsedAt = u.lastUsedAt;
    if (u.headersAt && (!acc.headersAt || u.headersAt > acc.headersAt)) { acc.headersAt = u.headersAt; acc.headers = stringHeaders(u.headers); }
    perName.set(nameKey(l), acc);
  }
  return perName;
}

/**
 * One entry per source. Layouts are the newest version of each saved name; usage and the last file's headers are
 * summed over all versions of that name. Outgoing columns come from the latest applied upload, as generation reads them.
 */
export async function templateEntries(data: TenantData, only?: UploadSource) {
  const all = await data.uploads.allMappings();
  const perName = await usageByName(data, all);
  const current = currentVersions(all);
  const currentIds = new Set(current.map(l => l.id));
  const byId = new Map(all.map(l => [l.id, l]));
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

  /**
   * Writes the next version of a saved layout; the old versions stay as they are, so applied uploads (which point at
   * theirs and hold their own copy of the mapping) and generated files never change. Only future uploads read the new
   * version. Comparisons read products and listings, never layouts, so no recompute is asked for.
   */
  update(ctx: RequestContext, source: UploadSource, input: z.infer<typeof updateTemplate>) {
    return this.auth.authenticated(ctx, { permission: 'settings.edit', mutation: true }, async (data, p) => {
      const versions = await data.uploads.layoutVersions(source, input.name);
      const latest = versions[0];
      if (!latest) throw new NotFoundException('Saved layout not found');
      if (latest.version !== input.expectedVersion) throw new ConflictException(STALE);
      const headers = (await usageByName(data, versions)).get(nameKey(latest))?.headers ?? null;
      const plan = planLayoutEdit(source, latest.fields, input.fields, headers);
      if (!plan.ok) throw new BadRequestException({ message: 'Mapping is not valid', details: plan.problems });
      if (plan.changes.length) {
        let saved;
        try {
          saved = await data.uploads.saveMapping(source, input.name, plan.fields, plan.signature);
        } catch (e) {
          // the tenant lock serialises writers; the unique (tenant, source, name, version) key is the last guard
          if ((e as { code?: unknown }).code === 'P2002') throw new ConflictException(STALE);
          throw e;
        }
        await data.event('template.updated', p.user.id, saved.id, ctx.requestId, {
          source, name: input.name, fromVersion: latest.version, toVersion: saved.version, changes: plan.changes,
        });
      }
      return (await templateEntries(data, source))[0]!;
    });
  }
}
