import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { ERP_CHANGE_KINDS } from '../../../../packages/core/src/upload/apply.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { CatalogueStockService } from './catalogue-stock.service.js';

const count = { type: 'integer' };
const kinds = [...ERP_CHANGE_KINDS];
const json = { description: 'string, number, boolean or null (the field value)' };
export const stockViewSchema = {
  type: 'object', properties: {
    erpStock: count, catalogueStock: { ...count, description: 'The stock the catalogue uses (recon, generated files)' },
    source: { type: 'string', enum: ['erp', 'owner'] },
    conflict: {
      type: ['object', 'null'], description: 'An open conflict: a later ERP stock differs from the one the owner value was set against',
      properties: { ownerStock: count, erpStock: count, erpStockAtEdit: count, inEffect: { type: 'string', enum: ['owner', 'erp'] } },
    },
  },
};
const changesSchema = {
  type: 'object', properties: {
    upload: { type: 'object' },
    changesRecorded: { type: 'boolean', description: 'false: applied before ADR 017; no per-row list exists' },
    kind: { type: 'string', enum: [...kinds, 'all'] }, conflictOnly: { type: 'boolean' }, page: count, pageSize: count, total: count,
    counts: { type: 'object', description: 'Rows per kind (cost only for roles that may change prices), all, and stockConflicts', additionalProperties: count },
    rows: {
      type: 'array', items: {
        type: 'object', properties: {
          productId: { type: 'string', format: 'uuid' }, barcode: { type: 'string' }, rowNumber: { type: ['integer', 'null'], description: 'null for missing' },
          kind: { type: 'string', enum: kinds }, field: { type: ['string', 'null'], description: 'null for new' }, old: json, new: json,
          stockConflict: { type: 'boolean' },
          product: { type: 'object', properties: { nameEn: { type: 'string' }, nameAr: { type: ['string', 'null'] }, status: { type: 'string' } } },
          fixedPriceRule: { type: ['boolean', 'null'], description: 'price rows: true = the product has a fixed price rule, which still applies' },
          catalogueStock: { ...stockViewSchema, type: ['object', 'null'], description: 'stock rows: the catalogue stock now' },
        },
      },
    },
  },
};
const conflictRow = {
  type: 'object', properties: {
    productId: { type: 'string', format: 'uuid' }, barcode: { type: 'string' }, nameEn: { type: 'string' }, nameAr: { type: ['string', 'null'] },
    status: { type: 'string' }, erpStock: count, ownerStock: count, erpStockAtEdit: count,
    catalogueStock: { ...count, description: 'The value in effect (the owner value while the conflict is open)' },
    reason: { type: ['string', 'null'] }, setBy: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
    setAt: { type: 'string', format: 'date-time' }, conflictUploadId: { type: 'string', format: 'uuid' }, conflictAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

@ApiTags('Catalogue stock')
@ApiCookieAuth()
@Controller('api')
export class CatalogueStockController {
  constructor(@Inject(CatalogueStockService) private readonly stock: CatalogueStockService, @Inject(CONFIG) private readonly config: Config) {}

  @Get('uploads/:id/changes') @Access({ permission: 'uploads.view' })
  @ApiQuery({ name: 'kind', required: false, enum: [...kinds, 'all'] })
  @ApiQuery({ name: 'conflict', required: false, enum: ['true', 'false'], description: 'true: only stock changes that raised a conflict' })
  @ApiQuery({ name: 'page', required: false }) @ApiQuery({ name: 'pageSize', required: false, description: '1-200, default 50' })
  @Contract('What an applied ERP upload changed in the catalogue, one row per product and field, in file order (missing products last), paginated; 400 for a marketplace upload, 409 when not applied', undefined, changesSchema)
  changes(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(dto.uploadChangesQuery)) query: z.infer<typeof dto.uploadChangesQuery>) {
    return this.stock.changes(context(req, this.config), id, query);
  }

  @Get('catalogue/stock/conflicts') @Access({ permission: 'products.view' })
  @ApiQuery({ name: 'page', required: false }) @ApiQuery({ name: 'pageSize', required: false, description: '1-200, default 50' })
  @Contract('Open stock conflicts (an ERP stock change met an owner-edited catalogue stock), newest first, with both values', undefined, {
    type: 'object', properties: { inEffect: { type: 'string', enum: ['owner', 'erp'] }, page: count, pageSize: count, total: count, rows: { type: 'array', items: conflictRow } },
  })
  conflicts(@Req() req: AppRequest, @Query(new ZodPipe(dto.stockConflictsQuery)) query: z.infer<typeof dto.stockConflictsQuery>) {
    return this.stock.conflicts(context(req, this.config), query);
  }

  @Get('catalogue/stock/conflicts/count') @Access({ permission: 'products.view' })
  @Contract('The number of open stock conflicts (the dashboard badge)', undefined, { type: 'object', properties: { count } })
  conflictCount(@Req() req: AppRequest) { return this.stock.conflictCount(context(req, this.config)); }

}
