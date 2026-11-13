import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { ProductsService } from './products.service.js';
import { MARKETPLACES } from '../../../../packages/core/src/constants.js';
import { RECON_REFERENCES, STOCK_ISSUES } from '../../../../packages/core/src/recon/status.js';
import { MARKETPLACE_COMPARISONS, MARKETPLACE_STATUS_FILTERS, MARKETPLACES_DIFFER, PRICE_ISSUES } from '../../../../packages/core/src/products/marketplace-view.js';

/** Only with ?marketplaceId. An object so later fields (for example an export value) can be added beside these. */
const marketplace = {
  type: 'object',
  description: 'Only with marketplaceId: the product on that marketplace (winning listing, its upload, the stored recon row)',
  properties: {
    marketplaceId: { type: 'string', enum: [...MARKETPLACES] },
    reference: { type: 'string', enum: [...RECON_REFERENCES], description: 'The comparison the status and issues use (the tenant default)' },
    available: { type: ['boolean', 'null'], description: 'Availability in the marketplace file; null when not in the file' },
    price: { type: ['string', 'null'], description: 'Price in the marketplace file, QAR with 3 decimals (e.g. "12.500"); null when not in the file' },
    inFile: { type: 'boolean' },
    comparison: { type: 'string', enum: [...MARKETPLACE_COMPARISONS], description: 'not_applicable: no upload yet, a new product, or not recomputed yet' },
    stockIssue: { type: ['string', 'null'], enum: [...STOCK_ISSUES, null] },
    priceIssue: { type: ['string', 'null'], enum: [...PRICE_ISSUES, null] },
    sourceUploadedAt: { type: ['string', 'null'], format: 'date-time', description: 'Upload time of the marketplace file the values came from' },
  },
};
const product = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }, barcode: { type: 'string' }, sku: { type: ['string', 'null'] }, nameEn: { type: 'string' },
    nameAr: { type: ['string', 'null'] }, brand: { type: ['string', 'null'] }, erpCategory: { type: ['string', 'null'] },
    categoryId: { type: ['string', 'null'], format: 'uuid' }, subcategoryId: { type: ['string', 'null'], format: 'uuid' },
    erpPrice: { type: 'number' }, costPrice: { type: ['number', 'null'], description: 'Only for roles that may change prices' },
    erpStock: { type: 'integer' }, status: { type: 'string', enum: ['new', 'active', 'inactive'] }, inLatestErpFile: { type: 'boolean' },
    catalogueStock: { type: 'integer', description: 'The stock the catalogue uses: the owner value while an edit exists, else the ERP stock' },
    catalogueStockSource: { type: 'string', enum: ['erp', 'owner'] }, stockConflict: { type: 'boolean', description: 'An ERP stock change met the owner value; resolve it' },
    updatedAt: { type: 'string', format: 'date-time' },
    marketplace,
    compareMarketplace: { ...marketplace, description: 'Only with compareMarketplaceId: the product on the second marketplace (same shape as marketplace)' },
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
  @ApiQuery({ name: 'marketplaceId', required: false, enum: [...MARKETPLACES], description: 'Adds a marketplace object to each product; the marketplace must be enabled for the store (else 400)' })
  @ApiQuery({ name: 'marketplaceStatus', required: false, enum: [...MARKETPLACE_STATUS_FILTERS], description: 'Only with marketplaceId; also applies to the tab counts' })
  @ApiQuery({ name: 'compareMarketplaceId', required: false, enum: [...MARKETPLACES], description: 'Only with marketplaceId, and another marketplace: adds a compareMarketplace object (same shape as marketplace); must be enabled (else 400)' })
  @ApiQuery({ name: 'marketplacesDiffer', required: false, enum: [...MARKETPLACES_DIFFER], description: 'Only with compareMarketplaceId: products whose listings on the two marketplaces differ in price (exact), availability or either, or that are listed on only one; also applies to the tab counts' })
  @Contract('Products ordered by English name, keyset paged, with a count per tab for the same search and category', undefined, {
    type: 'object', properties: { items: { type: 'array', items: product }, nextCursor: { type: ['string', 'null'] }, counts: tabCounts },
  })
  list(@Req() req: AppRequest, @Query(new ZodPipe(dto.productListQuery)) query: z.infer<typeof dto.productListQuery>) {
    return this.products.list(context(req, this.config), query);
  }

  @Post('activate') @HttpCode(200) @Access({ permission: 'products.activate' })
  @Contract('Activate new products: the given ids (max 500) or all new ones. No Arabic name or category is required; ids that are unknown, of another store or not new are skipped', dto.activateProducts, {
    type: 'object', properties: {
      activated: { type: 'integer' },
      arabicNameMissing: { type: 'integer', description: 'Activated products without an Arabic name (informational, never blocks)' },
      categoryMissing: { type: 'integer', description: 'Activated products without a category (informational, never blocks)' },
      skippedCount: { type: 'integer' },
      skipped: { type: 'array', description: 'First 200', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, reason: { type: 'string' } } } },
    },
  })
  activate(@Req() req: AppRequest, @Body(new ZodPipe(dto.activateProducts)) input: z.infer<typeof dto.activateProducts>) {
    return this.products.activate(context(req, this.config), input);
  }

  @Get('marketplace-listings') @Access({ permission: 'products.view' })
  @ApiQuery({ name: 'marketplaceId', required: true, enum: ['talabat', 'snoonu', 'rafeeq', 'keeta'] })
  @ApiQuery({ name: 'q', required: false, description: 'Listing or catalogue name, barcode prefix or marketplace product ID' })
  @ApiQuery({ name: 'availability', required: false, enum: ['all', 'available', 'unavailable'] })
  @ApiQuery({ name: 'match', required: false, enum: ['all', 'matched', 'unmatched'] })
  @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false })
  @Contract('Actual marketplace listings, including unmatched ones, keyset paged by marketplace product ID; total is for the current filters. Includes latest applied file metadata without storage keys.')
  marketplaceListings(@Req() req: AppRequest, @Query(new ZodPipe(dto.marketplaceListingsQuery)) query: z.infer<typeof dto.marketplaceListingsQuery>) {
    return this.products.marketplaceListings(context(req, this.config), query);
  }

  @Get(':id') @Access({ permission: 'products.view' })
  @Contract('One product with its marketplace listings, category names and the informational arabicNameMissing / categoryMissing flags')
  get(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.products.get(context(req, this.config), id); }

  @Patch(':id') @Access({ permission: 'products.edit' })
  @Contract('Edit the Qorloop-owned fields (Arabic name, category, subcategory, status). Activating (also re-activating) needs products.activate, not an Arabic name or category; expectedUpdatedAt gives 409 when the product changed', dto.updateProduct)
  update(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.updateProduct)) input: z.infer<typeof dto.updateProduct>) {
    return this.products.update(context(req, this.config), id, input);
  }
}
