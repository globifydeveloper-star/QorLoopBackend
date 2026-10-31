import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Put, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { MARKETPLACES } from '../../../../packages/core/src/constants.js';
import { PRICE_RULE_ORDER } from '../../../../packages/core/src/pricing.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { PricingService } from './pricing.service.js';

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

@ApiTags('Pricing')
@ApiCookieAuth()
@Controller('api')
export class PricingController {
  constructor(@Inject(PricingService) private readonly pricing: PricingService, @Inject(CONFIG) private readonly config: Config) {}

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
