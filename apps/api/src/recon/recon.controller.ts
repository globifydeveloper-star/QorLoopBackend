import { Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { MARKETPLACES } from '../../../../packages/core/src/constants.js';
import { PRICE_RULE_ORDER } from '../../../../packages/core/src/pricing.js';
import { RECON_REFERENCES, RECON_STATUSES, STOCK_ISSUES } from '../../../../packages/core/src/recon/status.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { ReconService } from './recon.service.js';

const count = { type: 'integer' };
const reference = { type: 'string', enum: [...RECON_REFERENCES] };
const summary = {
  type: 'object', properties: {
    reference, computedAt: { type: ['string', 'null'], format: 'date-time', description: 'When the summaries were last recomputed' },
    marketplaces: {
      type: 'array', items: {
        type: 'object', properties: {
          marketplaceId: { type: 'string', enum: [...MARKETPLACES] },
          hasData: { type: 'boolean', description: 'false: no applied upload yet (counts are noData, not zeros)' },
          stock: count, price: count, total: { ...count, description: 'stock + price; a product with both counts once in each' },
          listed: count, notListed: count, noData: count, missingFromErp: count, newCount: count,
          lastUploadAt: { type: ['string', 'null'], format: 'date-time' },
          stale: { type: 'boolean', description: 'The latest applied upload is older than the store setting staleHours' },
        },
      },
    },
  },
};
const money = { type: ['number', 'null'] };
const rows = {
  type: 'object', properties: {
    reference,
    items: {
      type: 'array', items: {
        type: 'object', properties: {
          productId: { type: 'string', format: 'uuid' }, barcode: { type: 'string' }, sku: { type: ['string', 'null'] },
          nameEn: { type: 'string' }, nameAr: { type: ['string', 'null'] }, productStatus: { type: 'string' }, erpStock: count,
          status: { type: 'string', enum: [...RECON_STATUSES], description: 'For the reference' },
          stockIssue: { type: ['string', 'null'], enum: [...STOCK_ISSUES, null] },
          priceMismatch: { type: 'boolean', description: 'For the reference' }, priceMismatchVsErp: { type: 'boolean' }, priceMismatchVsMarketplace: { type: 'boolean' },
          expectedPrice: { ...money, description: 'erpPrice or marketplacePrice, by reference' }, erpPrice: money, marketplacePrice: money,
          marketplacePriceSource: { type: ['string', 'null'], enum: [...PRICE_RULE_ORDER, null] }, actualPrice: { ...money, description: 'null: not listed' },
          erpAvailable: { type: ['boolean', 'null'] }, actualAvailable: { type: ['boolean', 'null'] }, lastUpdated: { type: 'string', format: 'date-time' },
        },
      },
    },
    nextCursor: { type: ['string', 'null'] },
  },
};

@ApiTags('Reconciliation')
@ApiCookieAuth()
@Controller('api/recon')
export class ReconController {
  constructor(@Inject(ReconService) private readonly recon: ReconService, @Inject(CONFIG) private readonly config: Config) {}

  @Get('summary') @Access({ permission: 'recon.view' })
  @ApiQuery({ name: 'reference', required: false, enum: [...RECON_REFERENCES], description: "Defaults to the store's comparison reference" })
  @Contract('Per marketplace: stock, price and total issues, listed, not listed, no data, missing from ERP, new, last upload and stale; the dashboard and reports read these rows', undefined, summary)
  summary(@Req() req: AppRequest, @Query(new ZodPipe(dto.reconSummaryQuery)) query: z.infer<typeof dto.reconSummaryQuery>) {
    return this.recon.summary(context(req, this.config), query);
  }

  @Get('rows') @Access({ permission: 'recon.view' })
  @ApiQuery({ name: 'marketplaceId', required: true, enum: [...MARKETPLACES] })
  @ApiQuery({ name: 'type', required: false, enum: ['stock', 'price', 'all'], description: 'stock issues, price mismatches (for the reference), or every row' })
  @ApiQuery({ name: 'status', required: false, enum: [...RECON_STATUSES] })
  @ApiQuery({ name: 'reference', required: false, enum: [...RECON_REFERENCES] })
  @ApiQuery({ name: 'limit', required: false }) @ApiQuery({ name: 'cursor', required: false })
  @Contract('One marketplace\'s recon rows, urgent first (available but out of stock, then unavailable but in stock, then price), paginated by cursor', undefined, rows)
  rows(@Req() req: AppRequest, @Query(new ZodPipe(dto.reconRowsQuery)) query: z.infer<typeof dto.reconRowsQuery>) {
    return this.recon.rows(context(req, this.config), query);
  }

  @Post('recompute') @HttpCode(200) @Access({ permission: 'pricing.edit' })
  @Contract('Queue a recompute of every recon row and summary of the store (coalesced with one already waiting)', undefined, { type: 'object', properties: { queued: { type: 'boolean' } } })
  recompute(@Req() req: AppRequest) {
    return this.recon.recompute(context(req, this.config));
  }
}
