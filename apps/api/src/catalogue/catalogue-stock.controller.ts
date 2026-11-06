import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { ERP_CHANGE_KINDS } from '../../../../packages/core/src/upload/apply.js';
import { STOCK_BULK_LIMIT } from '../../../../packages/core/src/catalogue-stock.js';
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

const productStockSchema = {
  type: 'object', properties: {
    productId: { type: 'string', format: 'uuid' }, ...stockViewSchema.properties,
    edit: {
      type: ['object', 'null'], properties: {
        stock: count, erpStockAtEdit: count, state: { type: 'string', enum: ['active', 'conflict'] }, reason: { type: ['string', 'null'] },
        setBy: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } }, setAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
};
const stockSide = { type: 'object', properties: { stock: count, source: { type: 'string', enum: ['erp', 'owner'] }, state: { type: ['string', 'null'] } } };
const bulkStockCounts = {
  selected: count, willChange: count, unchanged: count, notFound: { ...count, description: 'Unknown or other-store ids' },
  sets: { ...count, description: 'Owner values written' }, clears: { ...count, description: 'Edits removed (back to the ERP stock)' },
};
const bulkStockPreviewSchema = {
  type: 'object', properties: {
    selection: { type: 'object' }, action: { type: 'object' }, reason: { type: ['string', 'null'] }, limit: count, ...bulkStockCounts,
    rows: { type: 'array', maxItems: 10, items: { type: 'object', properties: { productId: { type: 'string' }, nameEn: { type: 'string' }, barcode: { type: 'string' }, status: { type: 'string' }, erpStock: count, op: { type: 'string', enum: ['set', 'clear'] }, old: stockSide, new: stockSide } } },
    previewToken: { type: 'string', description: 'Send it with apply: 409 if the re-planned writes differ' },
  },
};
const applied = {
  operationId: { type: 'string', format: 'uuid', description: 'The audit event' }, replayed: { type: 'boolean', description: 'true: this idempotency key was already applied; nothing was written again' },
  appliedAt: { type: 'string', format: 'date-time' },
};
const bulkStockApplySchema = { type: 'object', properties: { ...applied, ...bulkStockCounts } };
const conflictCounts = { selected: count, willResolve: count, notInConflict: count, notFound: count };
const conflictsPreviewSchema = {
  type: 'object', properties: {
    selection: { type: 'object' }, choice: { type: 'string', enum: ['erp', 'keep'] }, limit: count, ...conflictCounts,
    rows: { type: 'array', maxItems: 10, items: { type: 'object', properties: { productId: { type: 'string' }, nameEn: { type: 'string' }, barcode: { type: 'string' }, choice: { type: 'string' }, ownerStock: count, erpStock: count, erpStockAtEdit: count, catalogueStockAfter: count } } },
    previewToken: { type: 'string' },
  },
};
const conflictsApplySchema = { type: 'object', properties: { ...applied, ...conflictCounts } };

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

  @Get('products/:id/stock') @Access({ permission: 'products.view' })
  @Contract('A product\'s catalogue stock next to its ERP stock, the owner edit (who, when, why) and any open conflict', undefined, productStockSchema)
  get(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.stock.get(context(req, this.config), id); }

  @Put('products/:id/stock') @Access({ permission: 'catalogue.stock_edit' })
  @Contract('Set the catalogue stock (the ERP stock\'s own value clears the edit). expected = the ERP and catalogue stock as last shown: 409 when either moved. Owner, Admin, Catalogue Manager', dto.setProductStock, { ...productStockSchema, properties: { ...productStockSchema.properties, changed: { type: 'boolean' } } })
  set(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.setProductStock)) input: z.infer<typeof dto.setProductStock>) {
    return this.stock.set(context(req, this.config), id, { mode: 'set', stock: input.stock }, input.expected, input.reason);
  }

  @Delete('products/:id/stock') @Access({ permission: 'catalogue.stock_edit' })
  @ApiQuery({ name: 'expectedErpStock', required: true }) @ApiQuery({ name: 'expectedCatalogueStock', required: true })
  @Contract('Back to the ERP stock: remove the owner edit (no edit: changed false). 409 when the stock moved since it was shown', undefined, { ...productStockSchema, properties: { ...productStockSchema.properties, changed: { type: 'boolean' } } })
  reset(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(dto.resetProductStock)) q: z.infer<typeof dto.resetProductStock>) {
    return this.stock.set(context(req, this.config), id, { mode: 'erp' }, { erpStock: q.expectedErpStock, catalogueStock: q.expectedCatalogueStock }, null);
  }

  @Post('products/:id/stock/resolve') @HttpCode(200) @Access({ permission: 'catalogue.stock_edit' })
  @Contract('Resolve the product\'s open stock conflict: erp = use the ERP stock (the edit is removed), keep = keep the owner value (re-based on the current ERP stock). 409 without an open conflict or when it moved', dto.resolveProductStock, productStockSchema)
  resolve(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.resolveProductStock)) input: z.infer<typeof dto.resolveProductStock>) {
    return this.stock.resolve(context(req, this.config), id, input);
  }

  @Post('catalogue/stock/bulk/preview') @HttpCode(200) @Access({ permission: 'catalogue.stock_edit' })
  @Contract(`What a bulk catalogue stock change would do (at most ${STOCK_BULK_LIMIT} products): counts, the first 10 rows and a preview token. Writes nothing`, dto.stockBulkPreview, bulkStockPreviewSchema)
  bulkPreview(@Req() req: AppRequest, @Body(new ZodPipe(dto.stockBulkPreview)) input: z.infer<typeof dto.stockBulkPreview>) {
    return this.stock.bulkPreview(context(req, this.config), input);
  }

  @Post('catalogue/stock/bulk/apply') @HttpCode(200) @Access({ permission: 'catalogue.stock_edit' })
  @Contract('Apply a bulk catalogue stock change, re-planned from current data, in one transaction with one audit event; the same idempotencyKey and body answers the first result again (replayed: true), another body 409; a stale previewToken 409', dto.stockBulkApply, bulkStockApplySchema)
  bulkApply(@Req() req: AppRequest, @Body(new ZodPipe(dto.stockBulkApply)) input: z.infer<typeof dto.stockBulkApply>) {
    return this.stock.bulkApply(context(req, this.config), input);
  }

  @Post('catalogue/stock/conflicts/resolve/preview') @HttpCode(200) @Access({ permission: 'catalogue.stock_edit' })
  @Contract('What resolving stock conflicts in bulk would do (the given products or every open conflict): counts, the first 10 rows and a preview token. Writes nothing', dto.conflictsResolvePreview, conflictsPreviewSchema)
  conflictsPreview(@Req() req: AppRequest, @Body(new ZodPipe(dto.conflictsResolvePreview)) input: z.infer<typeof dto.conflictsResolvePreview>) {
    return this.stock.conflictsPreview(context(req, this.config), input);
  }

  @Post('catalogue/stock/conflicts/resolve/apply') @HttpCode(200) @Access({ permission: 'catalogue.stock_edit' })
  @Contract('Resolve stock conflicts in bulk in one transaction with one audit event; idempotent by idempotencyKey (replayed: true), a stale previewToken 409', dto.conflictsResolveApply, conflictsApplySchema)
  conflictsApply(@Req() req: AppRequest, @Body(new ZodPipe(dto.conflictsResolveApply)) input: z.infer<typeof dto.conflictsResolveApply>) {
    return this.stock.conflictsApply(context(req, this.config), input);
  }
}
