import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { activityQuery } from '../../../../packages/shared/src/contracts.js';
import { activityUuid, HISTORY_NOTICE, presentActivity } from '../../../../packages/core/src/activity.js';
import { hasPermission } from '../../../../packages/core/src/roles.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';

export function decodeActivityCursor(cursor: string) {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && z.iso.datetime().safeParse(v[0]).success && z.uuid().safeParse(v[1]).success) {
      return { time: v[0] as string, id: v[1] as string };
    }
  } catch { /* reject below */ }
  throw new BadRequestException('Invalid cursor');
}
@Injectable()
export class ActivityService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  list(ctx: RequestContext, query: z.infer<typeof activityQuery>, productId?: string) {
    const after = query.cursor ? decodeActivityCursor(query.cursor) : undefined;
    return this.auth.authenticated(ctx, { permission: 'activity.view' }, async (data, p) => {
      const id = productId ?? query.productId;
      if (productId && query.productId && productId !== query.productId) throw new BadRequestException('productId must match the path');
      if (id && !hasPermission(p.member.role, 'products.view')) throw new ForbiddenException('Permission denied');
      if (id && !await data.products.get(id)) throw new NotFoundException('Product not found');
      const rows = await data.activity.list({ ...query, productId: id, includeTenantUploads: !!productId, after, limit: query.limit + 1 });
      const page = rows.slice(0, query.limit), last = page.at(-1);
      return {
        items: page.map(r => {
          const details = r.details !== null && typeof r.details === 'object' ? r.details as Record<string, unknown> : {};
          return {
            id: r.id, time: r.time,
            actor: { id: r.actorId, name: r.actorId ? r.actorName ?? 'Former team member' : 'system', email: r.actorEmail },
            ...presentActivity(r.action, r.details, { productId: id, canViewCosts: hasPermission(p.member.role, 'pricing.edit') }),
            scope: r.scope === 'product' || r.action.startsWith('product.') ? 'product' : 'tenant',
            productId: r.scope === 'product' ? id! : r.action.startsWith('product.') ? r.entityId : null,
            uploadId: r.action.startsWith('upload.') ? r.entityId : activityUuid(details.uploadId),
          };
        }),
        nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify([last.time, last.id])).toString('base64url') : null,
        ...(productId ? { coverageNotice: HISTORY_NOTICE } : {}),
      };
    });
  }
}
