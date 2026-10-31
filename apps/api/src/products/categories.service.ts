import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type { TenantData } from '../../../../packages/db/src/database.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { ReconQueue } from '../../../../packages/shared/src/recon.js';
import { RECON_QUEUE } from '../tokens.js';

type CategoryRow = { id: string; parentId: string | null; nameEn: string; nameAr: string | null; sort: number };

function view(c: CategoryRow, productCount: number) {
  return { id: c.id, parentId: c.parentId, nameEn: c.nameEn, nameAr: c.nameAr, sort: c.sort, productCount };
}

@Injectable()
export class CategoriesService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RECON_QUEUE) private readonly recon: ReconQueue) {}

  /** Categories with their subcategories, by sort then name; productCount counts products filed under each. */
  tree(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'products.view' }, async data => {
      const [all, counts] = await Promise.all([data.categories.all(), data.products.countsByCategory()]);
      return all.filter(c => !c.parentId).map(c => ({
        ...view(c, counts.get(c.id) ?? 0),
        children: all.filter(s => s.parentId === c.id).map(s => view(s, counts.get(s.id) ?? 0)),
      }));
    });
  }

  /** A parent must be a top-level category of this tenant: the tree is two levels deep at most. */
  private async checkParent(data: TenantData, parentId: string) {
    const parent = await data.categories.get(parentId);
    if (!parent) throw new BadRequestException('Parent category not found');
    if (parent.parentId) throw new BadRequestException('A subcategory cannot have subcategories (two levels at most)');
  }
  private async checkUniqueName(data: TenantData, parentId: string | null, nameEn: string, exceptId?: string) {
    if (await data.categories.siblingNamed(parentId, nameEn, exceptId)) throw new ConflictException('A category with this name already exists here');
  }

  create(ctx: RequestContext, input: z.infer<typeof contracts.createCategory>) {
    return this.auth.authenticated(ctx, { permission: 'categories.manage', mutation: true }, async (data, p) => {
      const parentId = input.parentId ?? null;
      if (parentId) await this.checkParent(data, parentId);
      await this.checkUniqueName(data, parentId, input.nameEn);
      const c = await data.categories.create({ nameEn: input.nameEn, nameAr: input.nameAr ?? null, parentId, sort: input.sort ?? 0 });
      await data.event('category.created', p.user.id, c.id, ctx.requestId, { parentId });
      return view(c, 0);
    });
  }

  update(ctx: RequestContext, id: string, input: z.infer<typeof contracts.updateCategory>) {
    return this.auth.authenticated(ctx, { permission: 'categories.manage', mutation: true }, async (data, p) => {
      const current = await data.categories.get(id);
      if (!current) throw new NotFoundException('Category not found');
      const parentId = input.parentId === undefined ? current.parentId : input.parentId;
      if (parentId !== current.parentId) {
        if (parentId === id) throw new BadRequestException('A category cannot be its own parent');
        if (parentId) {
          await this.checkParent(data, parentId);
          if ((await data.categories.references(id)).children) throw new BadRequestException('A category with subcategories cannot become a subcategory (two levels at most)');
        }
        // products store a category and a subcategory separately: moving one would break their pairing
        const products = await data.products.usingCategory(id);
        if (products) throw new ConflictException({ message: 'Products use this category; move them before changing its level or parent', details: [{ path: 'products', count: products }] });
      }
      const nameEn = input.nameEn ?? current.nameEn;
      if (nameEn !== current.nameEn || parentId !== current.parentId) await this.checkUniqueName(data, parentId, nameEn, id);
      const changes = {
        ...(input.nameEn !== undefined ? { nameEn } : {}), ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}),
        ...(input.parentId !== undefined ? { parentId } : {}), ...(input.sort !== undefined ? { sort: input.sort } : {}),
      };
      await data.categories.update(id, changes);
      await data.event('category.updated', p.user.id, id, ctx.requestId, { fields: Object.keys(changes) });
      const counts = await data.products.countsByCategory();
      return view((await data.categories.get(id))!, counts.get(id) ?? 0);
    });
  }

  remove(ctx: RequestContext, id: string) {
    return this.auth.authenticated(ctx, { permission: 'categories.manage', mutation: true }, async (data, p) => {
      const current = await data.categories.get(id);
      if (!current) throw new NotFoundException('Category not found');
      const counts = { products: await data.products.usingCategory(id), ...await data.categories.references(id) };
      const inUse = Object.entries(counts).filter(([, n]) => n > 0);
      if (inUse.length) {
        throw new ConflictException({ message: 'This category is still in use', details: inUse.map(([path, count]) => ({ path, count })) });
      }
      await data.categories.delete(id);
      await data.event('category.deleted', p.user.id, id, ctx.requestId, { parentId: current.parentId });
      return { id, deleted: true };
    });
  }

  /** A hint list for building the tree: the ERP's own category texts, most used first. */
  erpSuggestions(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'categories.manage' }, data => data.products.erpCategories());
  }

  /** Filed products may now take a category price rule, so any update asks for a recon recompute after commit. */
  async assignFromErp(ctx: RequestContext, id: string, input: z.infer<typeof contracts.assignFromErp>) {
    const result = await this.auth.authenticated(ctx, { permission: 'categories.manage', mutation: true }, async (data, p) => {
      const category = await data.categories.get(id);
      if (!category) throw new NotFoundException('Category not found');
      if (category.parentId) throw new BadRequestException('Choose a top-level category; this one is a subcategory');
      const erpCategories = [...new Set(input.erpCategories)];
      const updated = await data.products.assignCategoryFromErp(id, erpCategories, p.user.id);
      await data.event('category.assigned_from_erp', p.user.id, id, ctx.requestId, { erpCategories, updated });
      return { updated };
    });
    if (result.updated) await this.recon.enqueueRecon(ctx.tenantId, 'product.category');
    return result;
  }
}
