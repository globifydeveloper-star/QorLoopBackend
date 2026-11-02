import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { MARKETPLACES } from '../../../../packages/core/src/constants.js';
import { PRICE_RULE_ORDER } from '../../../../packages/core/src/pricing.js';
import { ADOPT_SKIP_REASONS } from '../../../../packages/core/src/price-adoption.js';
import { BULK_BLOCK_REASONS, BULK_PRICE_LIMIT } from '../../../../packages/core/src/price-change.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { PricingService } from './pricing.service.js';
import { BulkPricingService } from './bulk-pricing.service.js';

const rule = { mode: { type: 'string', enum: ['percent', 'amount', 'fixed', 'same'] }, value: { type: 'number', description: 'Absent for same' } };
const settings = {
  type: 'object', properties: {
    defaultRule: { type: 'object', properties: rule }, rounding: { type: 'string' }, perMarketplaceEnabled: { type: 'boolean' },
    compareReferenceDefault: { type: 'string', enum: ['marketplace', 'erp'] },
    marketplaceRules: { type: 'array', items: { type: 'object', properties: { marketplaceId: { type: 'string', enum: [...MARKETPLACES] }, ...rule, rounding: { type: 'string' } } } },
    order: { type: 'array', items: { type: 'string', enum: [...PRICE_RULE_ORDER] }, description: 'The rule order, first wins' },
    updatedAt: { type: ['string', 'null'], format: 'date-time' },
  },
};
const source = { type: 'string', enum: [...PRICE_RULE_ORDER] };
export const productPricing = {
  type: 'object', properties: {
    marketplacePrice: { type: 'object', properties: { price: { type: 'number' }, source } },
    pricing: {
      type: 'object', properties: {
        order: { type: 'array', items: source },
        productRule: { type: ['object', 'null'], properties: rule },
        offer: { type: ['object', 'null'], properties: { price: { type: 'number' }, validFrom: { type: ['string', 'null'] }, validUntil: { type: ['string', 'null'] }, state: { type: 'string', enum: ['valid', 'scheduled', 'expired'] } } },
        chain: { type: 'array', items: { type: 'object', properties: { source, status: { type: 'string', enum: ['applied', 'overridden', 'not_set', 'expired', 'scheduled', 'disabled'] }, price: { type: 'number' }, rule: { type: 'object', properties: rule }, rounding: { type: 'string' } } } },
        marketplaces: { type: 'array', description: 'Per-marketplace prices, only when per-marketplace pricing is on', items: { type: 'object', properties: { marketplaceId: { type: 'string' }, price: { type: 'number' }, source } } },
      },
    },
  },
};

const marketplaceId = { type: 'string', enum: [...MARKETPLACES] };
const priced = { type: 'object', properties: { price: { type: 'number' }, source } };
export const inlinePricing = {
  type: 'object', properties: {
    productId: { type: 'string', format: 'uuid' }, marketplaceId, erpPrice: { type: 'number' },
    previous: { ...priced, description: 'The price on marketplaceId before this request' },
    resolved: { ...priced, description: 'The price on marketplaceId now (per-marketplace step included)' },
    rule: { type: ['object', 'null'], description: "The product's own rule; send rule.updatedAt back as expectedRuleUpdatedAt", properties: { ...rule, updatedAt: { type: 'string', format: 'date-time' } } },
    chain: { type: 'array', description: 'The rule order for marketplaceId: applied, overridden, not_set, expired, scheduled, disabled', items: { type: 'object' } },
    marketplaces: { type: 'array', description: 'The price on every enabled marketplace: a product rule applies to all of them', items: { type: 'object', properties: { marketplaceId, price: { type: 'number' }, source } } },
    changed: { type: 'boolean', description: 'false when the rule was already this one (or, on DELETE, there was none)' },
  },
};

const count = { type: 'integer' };
const byMarketplace = { type: 'object', description: 'Per other marketplace', additionalProperties: count };
const adoptCounts = {
  type: 'object', properties: {
    products: { ...count, description: 'Products in scope' }, adopted: count, created: { ...count, description: 'Products that had no rule' },
    replaced: { ...count, description: 'Products whose own rule is replaced (onlyWithoutRule false)' },
    fixedFallback: { ...count, description: 'percent mode: products given a fixed rule because no percent reaches the listing price' },
    fallbacks: { type: 'object', properties: { rounding: count, range: { ...count, description: 'Outside -90..1000 %' } } },
    skipped: { type: 'object', properties: Object.fromEntries(ADOPT_SKIP_REASONS.map(r => [r, count])) },
    conflicts: { type: 'object', description: 'Adopted products listed elsewhere at a different price (beyond the recon tolerance)', properties: { products: count, byMarketplace } },
  },
};
const adoptRow = {
  type: 'object', properties: {
    productId: { type: 'string', format: 'uuid' }, nameEn: { type: 'string' }, barcode: { type: 'string' }, erpPrice: { type: 'number' },
    currentPrice: { type: 'number' }, currentSource: source, newPrice: { type: 'number' }, difference: { type: 'number', description: 'newPrice - currentPrice' },
    rule: { type: 'object', properties: rule }, fallback: { type: ['string', 'null'], enum: ['rounding', 'range', null] },
    previousRule: { type: ['object', 'null'], properties: rule },
  },
};
const adoptPreview = {
  type: 'object', properties: {
    ...adoptCounts.properties, willAdopt: count,
    conflicts: {
      type: 'object', properties: {
        products: count, byMarketplace,
        examples: { type: 'array', maxItems: 20, items: { type: 'object', properties: {
          productId: { type: 'string' }, nameEn: { type: 'string' }, barcode: { type: 'string' }, marketplaceId: { type: 'string' }, sourcePrice: { type: 'number' }, otherPrice: { type: 'number' },
        } } },
      },
    },
    largestDifferences: { type: 'array', maxItems: 10, items: adoptRow },
    rows: { type: 'array', maxItems: 10, description: 'The first products adopted, in list order', items: adoptRow },
  },
};

const bulkRow = {
  type: 'object', properties: {
    productId: { type: 'string', format: 'uuid' }, nameEn: { type: 'string' }, barcode: { type: 'string' }, marketplaceId,
    oldPrice: { type: 'number', description: 'Resolved price on marketplaceId now' }, oldSource: source,
    newPrice: { type: 'number' }, newSource: source, difference: { type: 'number', description: 'newPrice - oldPrice' },
    previousRule: { type: ['object', 'null'], properties: rule }, rule: { type: ['object', 'null'], description: 'null = the product rule is removed (match_erp)', properties: rule },
  },
};
const bulkCountsSchema = {
  selected: { ...count, description: 'willChange + unchanged + blocked' }, willChange: count, unchanged: count, blocked: count,
  blockedReasons: { type: 'array', items: { type: 'object', properties: { reason: { type: 'string', enum: [...BULK_BLOCK_REASONS] }, message: { type: 'string' }, count } } },
  otherMarketplaces: { type: 'array', description: 'Changed products whose price also moves on another enabled marketplace (a product rule applies to all)', items: { type: 'object', properties: { marketplaceId, products: count } } },
};
const bulkPreviewSchema = {
  type: 'object', properties: {
    marketplaceId, action: { type: 'object' }, selection: { type: 'object' },
    reference: { type: 'string', enum: ['marketplace', 'erp'], description: 'Only with a reconStatus filter: the reference it read' },
    limit: { ...count, description: `At most ${BULK_PRICE_LIMIT} products per change` },
    ...bulkCountsSchema,
    largestIncrease: { ...bulkRow, type: ['object', 'null'] }, largestDecrease: { ...bulkRow, type: ['object', 'null'] },
    rows: { type: 'array', maxItems: 10, description: 'The first changes, in product list order', items: bulkRow },
    previewToken: { type: 'string', description: 'Send it with apply: 409 if the re-planned writes differ' },
  },
};
const bulkApplySchema = {
  type: 'object', properties: {
    operationId: { type: 'string', format: 'uuid', description: "The 'pricing.bulk_applied' audit event" },
    replayed: { type: 'boolean', description: 'true: this idempotency key was already applied; nothing was written again' },
    appliedAt: { type: 'string', format: 'date-time' },
    ...bulkCountsSchema,
    created: { ...count, description: 'Rules created (the product had none)' }, replaced: count, removed: { ...count, description: 'Rules removed (match_erp)' },
  },
};

@ApiTags('Pricing')
@ApiCookieAuth()
@Controller('api')
export class PricingController {
  constructor(
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(BulkPricingService) private readonly bulk: BulkPricingService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Post('pricing/bulk/preview') @HttpCode(200) @Access({ permission: 'pricing.bulk' })
  @Contract(`What a bulk price change would do on one marketplace (at most ${BULK_PRICE_LIMIT} products): counts, blocked reasons, the largest increase and decrease, the first 10 rows and a preview token. Writes nothing`, dto.bulkPricePreview, bulkPreviewSchema)
  bulkPreview(@Req() req: AppRequest, @Body(new ZodPipe(dto.bulkPricePreview)) input: z.infer<typeof dto.bulkPricePreview>) {
    return this.bulk.preview(context(req, this.config), input);
  }

  @Post('pricing/bulk/apply') @HttpCode(200) @Access({ permission: 'pricing.bulk' })
  @Contract('Apply a bulk price change, re-planned from current data, in one transaction with one audit event; the same idempotencyKey and body answers the first result again (replayed: true), another body 409; a stale previewToken 409', dto.bulkPriceApply, bulkApplySchema)
  bulkApply(@Req() req: AppRequest, @Body(new ZodPipe(dto.bulkPriceApply)) input: z.infer<typeof dto.bulkPriceApply>) {
    return this.bulk.apply(context(req, this.config), input);
  }

  @Get('pricing/settings') @Access({ permission: 'pricing.view' })
  @Contract('Default rule, rounding, per-marketplace switch and rules, comparison reference and the rule order', undefined, settings)
  settings(@Req() req: AppRequest) { return this.pricing.settings(context(req, this.config)); }

  @Put('pricing/settings') @Access({ permission: 'pricing.edit' })
  @Contract('Change any of the pricing settings; marketplaceRules, when given, is the full set (one audit event per changed field or rule)', dto.updatePricingSettings, settings)
  updateSettings(@Req() req: AppRequest, @Body(new ZodPipe(dto.updatePricingSettings)) input: z.infer<typeof dto.updatePricingSettings>) {
    return this.pricing.updateSettings(context(req, this.config), input);
  }

  @Get('pricing/category-rules') @Access({ permission: 'pricing.view' })
  @Contract('Every category and subcategory price rule, with category names', undefined, {
    type: 'array', items: { type: 'object', properties: { categoryId: { type: 'string' }, subcategoryId: { type: ['string', 'null'] }, ...rule } },
  })
  categoryRules(@Req() req: AppRequest) { return this.pricing.categoryRules(context(req, this.config)); }

  @Put('pricing/category-rules') @Access({ permission: 'pricing.edit' })
  @Contract('Set the rule of a category, or of one of its subcategories', dto.categoryPriceRule)
  setCategoryRule(@Req() req: AppRequest, @Body(new ZodPipe(dto.categoryPriceRule)) input: z.infer<typeof dto.categoryPriceRule>) {
    return this.pricing.setCategoryRule(context(req, this.config), input);
  }

  @Delete('pricing/category-rules') @Access({ permission: 'pricing.edit' })
  @ApiQuery({ name: 'categoryId', required: true }) @ApiQuery({ name: 'subcategoryId', required: false, description: 'Omit for the category-level rule' })
  @Contract('Remove a category or subcategory rule (404 when there is none)')
  deleteCategoryRule(@Req() req: AppRequest, @Query(new ZodPipe(dto.categoryPriceRuleKey)) key: z.infer<typeof dto.categoryPriceRuleKey>) {
    return this.pricing.deleteCategoryRule(context(req, this.config), key);
  }

  @Post('pricing/adopt/preview') @HttpCode(200) @Access({ permission: 'pricing.edit' })
  @Contract("What adopting a marketplace's current listing prices as product rules would do: counts, skips by reason, other-marketplace conflicts, the largest changes and the first rows (writes nothing)", dto.adoptPrices, adoptPreview)
  adoptPreview(@Req() req: AppRequest, @Body(new ZodPipe(dto.adoptPrices)) input: z.infer<typeof dto.adoptPrices>) {
    return this.pricing.adoptPreview(context(req, this.config), input);
  }

  @Post('pricing/adopt/apply') @HttpCode(200) @Access({ permission: 'pricing.edit' })
  @Contract("Adopt a marketplace's current listing prices as product rules, in one transaction; a repeat adopts nothing", dto.adoptPrices, adoptCounts)
  adoptApply(@Req() req: AppRequest, @Body(new ZodPipe(dto.adoptPrices)) input: z.infer<typeof dto.adoptPrices>) {
    return this.pricing.adoptApply(context(req, this.config), input);
  }

  @Put('pricing/products/:id') @Access({ permission: 'pricing.edit' })
  @Contract("Inline price edit: a fixed price or a percent over the ERP price, seen from one enabled marketplace, stored as the product's own rule (so it applies on every marketplace). Active products only; 409 when expectedRuleUpdatedAt is stale", dto.inlinePrice, inlinePricing)
  setInlinePrice(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.inlinePrice)) input: z.infer<typeof dto.inlinePrice>) {
    return this.pricing.setInlinePrice(context(req, this.config), id, input);
  }

  @Delete('pricing/products/:id') @Access({ permission: 'pricing.edit' })
  @ApiQuery({ name: 'marketplaceId', required: true, enum: [...MARKETPLACES] })
  @ApiQuery({ name: 'expectedRuleUpdatedAt', required: false, description: 'rule.updatedAt as last seen; 409 when the rule changed or is gone' })
  @Contract("Inline 'back to the ERP price': remove the product's own rule so the category, per-marketplace and default rules apply again (no rule: changed false)", undefined, inlinePricing)
  removeInlinePrice(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(dto.inlinePriceRemove)) query: z.infer<typeof dto.inlinePriceRemove>) {
    return this.pricing.removeInlinePrice(context(req, this.config), id, query);
  }

  @Put('products/:id/price-rule') @Access({ permission: 'pricing.edit' })
  @Contract("Set the product's own price rule", dto.priceRule, productPricing)
  setProductRule(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.priceRule)) input: z.infer<typeof dto.priceRule>) {
    return this.pricing.setProductRule(context(req, this.config), id, input);
  }

  @Delete('products/:id/price-rule') @Access({ permission: 'pricing.edit' })
  @Contract("Remove the product's own price rule (404 when there is none)", undefined, productPricing)
  deleteProductRule(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.pricing.deleteProductRule(context(req, this.config), id);
  }

  @Put('products/:id/offer') @Access({ permission: 'pricing.edit' })
  @Contract('Set the product offer (replaces any other); it applies between validFrom and validUntil when given', dto.productOffer, productPricing)
  setOffer(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.productOffer)) input: z.infer<typeof dto.productOffer>) {
    return this.pricing.setOffer(context(req, this.config), id, input);
  }

  @Delete('products/:id/offer') @Access({ permission: 'pricing.edit' })
  @Contract('Remove the product offer (404 when there is none)', undefined, productPricing)
  deleteOffer(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.pricing.deleteOffer(context(req, this.config), id);
  }
}
