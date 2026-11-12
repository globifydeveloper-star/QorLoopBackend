import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { MARKETPLACES, type MarketplaceId } from '../../../../packages/core/src/constants.js';
import { BLOCKED_REASONS, EXPORT_STATES, MARKETPLACE_VALUES_BULK_LIMIT, NOT_EXPORTABLE_REASONS } from '../../../../packages/core/src/marketplace-values.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { MarketplaceValuesService } from './marketplace-values.service.js';

const marketplaceParam = new ZodPipe(z.enum(MARKETPLACES));
const count = { type: 'integer' };
const money = { type: ['number', 'null'] };
const bool = { type: ['boolean', 'null'] };
const state = { type: 'string', enum: [...EXPORT_STATES] };
const field = { type: 'object', properties: { state, blockedReason: { type: ['string', 'null'], enum: [...BLOCKED_REASONS, null] } } };
const value = (v: Record<string, unknown>) => ({
  type: ['object', 'null'], description: 'The export value of this field (null: never set)', properties: {
    value: v, persistent: { type: 'boolean', description: 'true: pinned (never cleared by an upload); false: fix once' },
    state: { type: 'string', enum: ['pending', 'cleared'] }, fieldState: state,
    setBy: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: ['string', 'null'] } } },
    setAt: { type: 'string', format: 'date-time' }, reason: { type: ['string', 'null'] }, clearedAt: { type: ['string', 'null'], format: 'date-time' },
  },
});
export const exportCountsSchema = {
  type: 'object', description: 'Row states of the Review list (catalogue reference)',
  properties: { toFix: count, waitingForExport: count, pinned: count, blocked: count },
};
export const reviewItemSchema = {
  type: ['object', 'null'], properties: {
    productId: { type: 'string', format: 'uuid' }, barcode: { type: 'string' }, sku: { type: ['string', 'null'] },
    nameEn: { type: 'string' }, nameAr: { type: ['string', 'null'] }, productStatus: { type: 'string' },
    reconStatus: { type: 'string', description: 'The comparison status against the catalogue (stored recon)' },
    marketplaceCurrent: { type: 'object', description: 'What the marketplace file showed (null: not listed)', properties: { available: bool, price: money } },
    catalogue: {
      type: 'object', description: 'What it should be (the source of truth)', properties: {
        available: bool, price: { ...money, description: 'The rule price' }, priceSource: { type: ['string', 'null'] },
        stock: count, stockSource: { type: 'string', enum: ['erp', 'owner'] }, stockConflict: { type: 'boolean' },
      },
    },
    export: {
      type: 'object', description: 'What the next generated file writes (null: the file cannot write this product)', properties: {
        available: bool, price: money, availabilitySource: { type: 'string', enum: ['catalogue', 'override'] }, priceSource: { type: 'string', enum: ['catalogue', 'override'] },
      },
    },
    values: { type: 'object', properties: { availability: value({ type: 'boolean' }), price: value({ type: 'number' }) } },
    fields: { type: 'object', properties: { availability: field, price: field } },
    exportState: state, exportStateLabel: { type: ['string', 'null'] },
    blockedReason: { type: ['string', 'null'], enum: [...BLOCKED_REASONS, null] }, blockedReasonLabel: { type: ['string', 'null'] },
    notExportableReason: { type: ['string', 'null'], enum: [...NOT_EXPORTABLE_REASONS, null] },
    rulePrice: money, differsFromRulePrice: { type: 'boolean', description: 'A pending typed price differs from the rule price (exact, in fils)' },
    needsChange: { type: 'boolean' },
    version: { type: ['object', 'null'], description: 'Send back as expected / expectedId+expectedVersion', properties: { id: { type: 'string', format: 'uuid' }, version: count } },
    marketplaceSource: {
      type: ['object', 'null'], description: 'The marketplace file the current values came from', properties: {
        uploadId: { type: 'string', format: 'uuid' }, fileName: { type: ['string', 'null'] }, uploadedAt: { type: 'string', format: 'date-time' },
        appliedAt: { type: ['string', 'null'], format: 'date-time' }, isLatestFile: { type: 'boolean', description: 'The file generated files are built from' },
      },
    },
    lastUpdated: { type: 'string', format: 'date-time', description: 'When the stored comparison of this row last changed' },
  },
};
const changeResult = { type: 'object', properties: { changed: { type: 'boolean' }, operationId: { type: ['string', 'null'], format: 'uuid' }, item: reviewItemSchema } };
const bulkCounts = {
  selected: count, willChange: count, unchanged: count, blocked: count,
  blockedByReason: { type: 'array', items: { type: 'object', properties: { reason: { type: 'string' }, label: { type: 'string' }, count } } },
};

@ApiTags('Marketplace export values')
@ApiCookieAuth()
@Controller('api/marketplace-values')
export class MarketplaceValuesController {
  constructor(@Inject(MarketplaceValuesService) private readonly values: MarketplaceValuesService, @Inject(CONFIG) private readonly config: Config) {}

  @Get('review') @Access({ permission: 'recon.view' })
  @ApiQuery({ name: 'marketplaceId', required: true, enum: [...MARKETPLACES] })
  @ApiQuery({ name: 'show', required: false, enum: ['needs_change', 'all'], description: 'Default needs_change: blocked, waiting for export, to fix' })
  @ApiQuery({ name: 'exportState', required: false, enum: [...EXPORT_STATES] })
  @ApiQuery({ name: 'field', required: false, enum: ['availability', 'price'] })
  @ApiQuery({ name: 'q', required: false }) @ApiQuery({ name: 'categoryId', required: false }) @ApiQuery({ name: 'subcategoryId', required: false })
  @ApiQuery({ name: 'limit', required: false }) @ApiQuery({ name: 'cursor', required: false })
  @Contract('The Review screen of one marketplace: products that differ from the catalogue or carry an export value, most urgent first, with the counts', undefined, {
    type: 'object', properties: {
      marketplaceId: { type: 'string', enum: [...MARKETPLACES] }, marketplaceEnabled: { type: 'boolean' }, counts: exportCountsSchema,
      latestFile: { type: ['object', 'null'], properties: { uploadId: { type: 'string' }, fileName: { type: 'string' }, uploadedAt: { type: 'string' }, appliedAt: { type: ['string', 'null'] } } },
      items: { type: 'array', items: reviewItemSchema }, nextCursor: { type: ['string', 'null'] },
    },
  })
  review(@Req() req: AppRequest, @Query(new ZodPipe(dto.marketplaceReviewQuery)) query: z.infer<typeof dto.marketplaceReviewQuery>) {
    return this.values.review(context(req, this.config), query);
  }

  @Post('bulk/preview') @HttpCode(200) @Access({ permission: 'marketplace.values_edit' })
  @Contract(`What a bulk set or "use catalogue values" would do now (at most ${MARKETPLACE_VALUES_BULK_LIMIT} selected products); writes nothing`, dto.marketplaceValuesBulkPreview, {
    type: 'object', properties: { ...bulkCounts, limit: count, rows: { type: 'array', items: { type: 'object' } }, previewToken: { type: 'string' } },
  })
  bulkPreview(@Req() req: AppRequest, @Body(new ZodPipe(dto.marketplaceValuesBulkPreview)) input: z.infer<typeof dto.marketplaceValuesBulkPreview>) {
    return this.values.bulkPreview(context(req, this.config), input);
  }

  @Post('bulk/apply') @HttpCode(200) @Access({ permission: 'marketplace.values_edit' })
  @Contract('Apply a previewed bulk change (previewToken and idempotencyKey required); one audit event', dto.marketplaceValuesBulkApply, {
    type: 'object', properties: {
      operationId: { type: 'string', format: 'uuid' }, replayed: { type: 'boolean' }, appliedAt: { type: 'string', format: 'date-time' },
      marketplaceId: { type: 'string' }, ...bulkCounts, created: count, updated: count, clearedFields: count,
    },
  })
  bulkApply(@Req() req: AppRequest, @Body(new ZodPipe(dto.marketplaceValuesBulkApply)) input: z.infer<typeof dto.marketplaceValuesBulkApply>) {
    return this.values.bulkApply(context(req, this.config), input);
  }

  @Get(':marketplaceId/products/:productId') @Access({ permission: 'recon.view' })
  @Contract('One product\'s Review row on one marketplace (null before the first comparison of a newly enabled marketplace)', undefined, reviewItemSchema)
  item(@Req() req: AppRequest, @Param('marketplaceId', marketplaceParam) marketplaceId: MarketplaceId, @Param('productId', new ParseUUIDPipe()) productId: string) {
    return this.values.item(context(req, this.config), marketplaceId, productId);
  }

  @Put(':marketplaceId/products/:productId') @Access({ permission: 'marketplace.values_edit' })
  @Contract('Set the availability and/or price the file writes for this product on this marketplace only', dto.setMarketplaceValues, changeResult)
  set(@Req() req: AppRequest, @Param('marketplaceId', marketplaceParam) marketplaceId: MarketplaceId, @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body(new ZodPipe(dto.setMarketplaceValues)) input: z.infer<typeof dto.setMarketplaceValues>) {
    return this.values.set(context(req, this.config), marketplaceId, productId, input);
  }

  @Delete(':marketplaceId/products/:productId') @Access({ permission: 'marketplace.values_edit' })
  @ApiQuery({ name: 'fields', required: false, enum: ['availability', 'price', 'all'] })
  @ApiQuery({ name: 'expectedId', required: false }) @ApiQuery({ name: 'expectedVersion', required: false })
  @Contract('"Use catalogue value": remove the export value; the file writes the current catalogue value', undefined, changeResult)
  clear(@Req() req: AppRequest, @Param('marketplaceId', marketplaceParam) marketplaceId: MarketplaceId, @Param('productId', new ParseUUIDPipe()) productId: string,
    @Query(new ZodPipe(dto.clearMarketplaceValuesQuery)) query: z.infer<typeof dto.clearMarketplaceValuesQuery>) {
    return this.values.clear(context(req, this.config), marketplaceId, productId, query);
  }
}
