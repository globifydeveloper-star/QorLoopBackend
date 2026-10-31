import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { ProductsService } from './products.service.js';

const product = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }, barcode: { type: 'string' }, sku: { type: ['string', 'null'] }, nameEn: { type: 'string' },
    nameAr: { type: ['string', 'null'] }, brand: { type: ['string', 'null'] }, erpCategory: { type: ['string', 'null'] },
    categoryId: { type: ['string', 'null'], format: 'uuid' }, subcategoryId: { type: ['string', 'null'], format: 'uuid' },
    erpPrice: { type: 'number' }, costPrice: { type: ['number', 'null'], description: 'Only for roles that may change prices' },
    erpStock: { type: 'integer' }, status: { type: 'string', enum: ['new', 'active', 'inactive'] }, inLatestErpFile: { type: 'boolean' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};
const tabCounts = { type: 'object', properties: Object.fromEntries(dto.productTab.options.map(t => [t, { type: 'integer' }])) };

@ApiTags('Products')
@ApiCookieAuth()
@Controller('api/products')
export class ProductsController {
  constructor(@Inject(ProductsService) private readonly products: ProductsService, @Inject(CONFIG) private readonly config: Config) {}

  @Get() @Access({ permission: 'products.view' })
  @ApiQuery({ name: 'q', required: false, description: 'English name (contains), barcode (normalised, prefix) or SKU (exact)' })
  @ApiQuery({ name: 'tab', required: false, enum: dto.productTab.options, description: 'missing = not in the latest full ERP file' })
  @ApiQuery({ name: 'categoryId', required: false }) @ApiQuery({ name: 'subcategoryId', required: false })
  @ApiQuery({ name: 'limit', required: false, description: '1-200, default 50' })
  @ApiQuery({ name: 'cursor', required: false, description: 'nextCursor from the previous page' })
  @Contract('Products ordered by English name, keyset paged, with a count per tab for the same search and category', undefined, {
    type: 'object', properties: { items: { type: 'array', items: product }, nextCursor: { type: ['string', 'null'] }, counts: tabCounts },
  })
  list(@Req() req: AppRequest, @Query(new ZodPipe(dto.productListQuery)) query: z.infer<typeof dto.productListQuery>) {
    return this.products.list(context(req, this.config), query);
  }

  @Post('activate') @HttpCode(200) @Access({ permission: 'products.activate' })
  @Contract('Activate new products that are ready (Arabic name and category by default): the given ids (max 500) or all new ones', dto.activateProducts, {
    type: 'object', properties: {
      activated: { type: 'integer' }, skippedCount: { type: 'integer' },
      skipped: { type: 'array', description: 'First 200', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, reason: { type: 'string' } } } },
    },
  })
  activate(@Req() req: AppRequest, @Body(new ZodPipe(dto.activateProducts)) input: z.infer<typeof dto.activateProducts>) {
    return this.products.activate(context(req, this.config), input);
  }

  @Get(':id') @Access({ permission: 'products.view' })
  @Contract('One product with its marketplace listings and category names')
  get(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.products.get(context(req, this.config), id); }

  @Patch(':id') @Access({ permission: 'products.edit' })
  @Contract('Edit the Qorloop-owned fields (Arabic name, category, subcategory, status). Activating needs products.activate and a ready product; expectedUpdatedAt gives 409 when the product changed', dto.updateProduct)
  update(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.updateProduct)) input: z.infer<typeof dto.updateProduct>) {
    return this.products.update(context(req, this.config), id, input);
  }
}
