import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { ProductsService } from './products.service.js';
import { ProductBlocksService } from './product-blocks.service.js';
import { BLOCKED_FILTERS, PRODUCT_BLOCK_FILTER_MAX, PRODUCT_BLOCK_IDS_MAX, PRODUCT_BLOCK_REASONS } from '../../../../packages/core/src/products/blocking.js';
import { MARKETPLACES } from '../../../../packages/core/src/constants.js';
import { RECON_REFERENCES, STOCK_ISSUES } from '../../../../packages/core/src/recon/status.js';
import { MARKETPLACE_COMPARISONS, MARKETPLACE_STATUS_FILTERS, MARKETPLACES_DIFFER, PRICE_ISSUES } from '../../../../packages/core/src/products/marketplace-view.js';
import { offerViewSchema } from '../pricing/pricing.controller.js';

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
    isBlocked: { type: 'boolean', description: 'Blocked (old or seasonal): ignored by every check and change; separate from status' },
    blockedAt: { type: ['string', 'null'], format: 'date-time' },
    blockedReason: { type: ['string', 'null'], enum: [...PRODUCT_BLOCK_REASONS, null] },
    catalogueStock: { type: 'integer', description: 'The stock the catalogue uses: the owner value while an edit exists, else the ERP stock' },
    catalogueStockSource: { type: 'string', enum: ['erp', 'owner'] }, stockConflict: { type: 'boolean', description: 'An ERP stock change met the owner value; resolve it' },
    updatedAt: { type: 'string', format: 'date-time' },
    marketplace,
    compareMarketplace: { ...marketplace, description: 'Only with compareMarketplaceId: the product on the second marketplace (same shape as marketplace)' },
    marketplacePrice: { type: 'object', description: 'Only with pricing.view: the resolved price (offer included), without the per-marketplace step', properties: { price: { type: 'number' }, source: { type: 'string' } } },
    normalPrice: { type: 'number', description: 'Only with pricing.view: the price without the offer, without the per-marketplace step' },
    offer: { ...offerViewSchema, type: ['object', 'null'], description: "Only with pricing.view: the product's offer in any state (scheduled, active, ended), null when none" },
  },
};
const tabCounts = {
  type: 'object',
  properties: {
    ...Object.fromEntries(dto.productTab.options.map(t => [t, { type: 'integer' }])),
    blocked: { type: 'integer', description: 'Blocked products of the same search and category, whatever the blocked filter (the Blocked tab)' },
  },
};
const blockPreview = {
  type: 'object', properties: {
    reason: { type: 'string', enum: [...PRODUCT_BLOCK_REASONS] }, reasonLabel: { type: 'string' },
    selected: { type: 'integer', description: 'toBlock + alreadyBlocked' }, toBlock: { type: 'integer' }, alreadyBlocked: { type: 'integer' },
    notFound: { type: 'integer', description: 'Requested ids that are not products of this store' },
    activeOffersToEnd: { type: 'integer', description: 'Active offers on the products to block; they end on block and do not come back on unblock' },
    offersNote: { type: ['string', 'null'] },
    previewToken: { type: 'string', description: 'Send it to POST /api/products/block' },
  },
};
const blockResult = {
  type: 'object', properties: {
    reason: { type: 'string', enum: [...PRODUCT_BLOCK_REASONS] }, reasonLabel: { type: 'string' },
    blocked: { type: 'integer' }, alreadyBlocked: { type: 'integer' }, notFound: { type: 'integer' },
    offersEnded: { type: 'integer', description: 'Active offers ended (valid_until set to now)' }, offersNote: { type: ['string', 'null'] },
    blockedAt: { type: 'string', format: 'date-time' },
  },
};
const unblockResult = {
  type: 'object', properties: {
    unblocked: { type: 'integer' }, notBlocked: { type: 'integer' }, notFound: { type: 'integer' },
    offersRestored: { type: 'integer', enum: [0], description: 'Always 0: offers ended by the block are not restored' }, offersNote: { type: 'string' },
  },
};

@ApiTags('Products')
@ApiCookieAuth()
@Controller('api/products')
export class ProductsController {
  constructor(
    @Inject(ProductsService) private readonly products: ProductsService, @Inject(ProductBlocksService) private readonly blocks: ProductBlocksService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

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
  @ApiQuery({ name: 'blocked', required: false, enum: [...BLOCKED_FILTERS], description: 'exclude (default): no blocked products in the list or the tab counts; only: the Blocked tab; include: both. counts.blocked is always the blocked count' })
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

  @Post('block/preview') @HttpCode(200) @Access({ permission: 'products.block' })
  @Contract(`What blocking would do: the products to block (productIds, max ${PRODUCT_BLOCK_IDS_MAX}, or the catalogue filter, max ${PRODUCT_BLOCK_FILTER_MAX.toLocaleString('en-US')} matches, else 400), those already blocked and the active offers that will end. Writes nothing`, dto.blockProductsPreview, blockPreview)
  blockPreview(@Req() req: AppRequest, @Body(new ZodPipe(dto.blockProductsPreview)) input: z.infer<typeof dto.blockProductsPreview>) {
    return this.blocks.preview(context(req, this.config), input);
  }

  @Post('block') @HttpCode(200) @Access({ permission: 'products.block' })
  @Contract('Block the previewed products (old, seasonal or other): status is kept, active offers end now (not restored on unblock), their reconciliation rows are removed and a recompute is queued. 409 when the selection or its offers changed since the preview', dto.blockProducts, blockResult)
  block(@Req() req: AppRequest, @Body(new ZodPipe(dto.blockProducts)) input: z.infer<typeof dto.blockProducts>) {
    return this.blocks.block(context(req, this.config), input);
  }

  @Post('unblock') @HttpCode(200) @Access({ permission: 'products.block' })
  @Contract(`Unblock products (productIds, max ${PRODUCT_BLOCK_IDS_MAX}, or the catalogue filter over blocked products): they are exactly as before the block, except that ended offers stay ended. A recompute is queued`, dto.unblockProducts, unblockResult)
  unblock(@Req() req: AppRequest, @Body(new ZodPipe(dto.unblockProducts)) input: z.infer<typeof dto.unblockProducts>) {
    return this.blocks.unblock(context(req, this.config), input);
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
