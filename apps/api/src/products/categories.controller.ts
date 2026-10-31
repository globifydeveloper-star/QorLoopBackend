import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { CategoriesService } from './categories.service.js';

const category = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }, parentId: { type: ['string', 'null'], format: 'uuid' }, nameEn: { type: 'string' },
    nameAr: { type: ['string', 'null'] }, sort: { type: 'integer' }, productCount: { type: 'integer' },
  },
};

@ApiTags('Categories')
@ApiCookieAuth()
@Controller('api/categories')
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly categories: CategoriesService, @Inject(CONFIG) private readonly config: Config) {}

  @Get() @Access({ permission: 'products.view' })
  @Contract('The category tree (categories with their subcategories) with product counts', undefined, {
    type: 'array', items: { ...category, properties: { ...category.properties, children: { type: 'array', items: category } } },
  })
  tree(@Req() req: AppRequest) { return this.categories.tree(context(req, this.config)); }

  @Get('erp-suggestions') @Access({ permission: 'categories.manage' })
  @Contract('Distinct trimmed ERP category texts with product counts, most used first (a hint list)', undefined, {
    type: 'array', items: { type: 'object', properties: { erpCategory: { type: 'string' }, products: { type: 'integer' }, unassigned: { type: 'integer' } } },
  })
  erpSuggestions(@Req() req: AppRequest) { return this.categories.erpSuggestions(context(req, this.config)); }

  @Post() @HttpCode(200) @Access({ permission: 'categories.manage' })
  @Contract('Create a category, or a subcategory with parentId; names are unique among siblings ignoring case', dto.createCategory, category)
  create(@Req() req: AppRequest, @Body(new ZodPipe(dto.createCategory)) input: z.infer<typeof dto.createCategory>) {
    return this.categories.create(context(req, this.config), input);
  }

  @Patch(':id') @Access({ permission: 'categories.manage' })
  @Contract('Rename, re-sort or move a category (two levels at most; 409 when products use a category being moved)', dto.updateCategory, category)
  update(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.updateCategory)) input: z.infer<typeof dto.updateCategory>) {
    return this.categories.update(context(req, this.config), id, input);
  }

  @Delete(':id') @Access({ permission: 'categories.manage' })
  @Contract('Delete an unused category; 409 with counts while products, subcategories, mappings or price rules use it')
  remove(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.categories.remove(context(req, this.config), id); }

  @Post(':id/assign-from-erp') @HttpCode(200) @Access({ permission: 'categories.manage' })
  @Contract('File uncategorised products whose ERP category is one of the given texts under this category', dto.assignFromErp, {
    type: 'object', properties: { updated: { type: 'integer' } },
  })
  assignFromErp(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.assignFromErp)) input: z.infer<typeof dto.assignFromErp>) {
    return this.categories.assignFromErp(context(req, this.config), id, input);
  }
}
