import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { CONFIG } from '../tokens.js';
import { StoreResetService } from './store-reset.service.js';

const count = { type: 'integer', minimum: 0 };
const summary = { type: 'object', properties: Object.fromEntries(['products', 'categories', 'uploads', 'generatedFiles', 'marketplaceListings', 'comparisonRows',
  'priceRules', 'offers', 'exportValues', 'stockEdits', 'notifications', 'activityEntries', 'totalRows'].map(k => [k, count])) };
const previewSchema = { type: 'object', required: ['store', 'deletes', 'inFlightUploads', 'blockedReason'], properties: {
  store: { type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' } } },
  deletes: summary, inFlightUploads: count, blockedReason: { type: ['string', 'null'] },
} };
const resultSchema = { type: 'object', required: ['eventId', 'deleted', 'storageCleanup'], properties: {
  eventId: { type: 'string', format: 'uuid' }, deleted: summary, storageCleanup: { type: 'string', enum: ['queued', 'not_queued'] },
} };

@ApiTags('Store') @ApiCookieAuth()
@Controller('api/store')
export class StoreResetController {
  constructor(@Inject(StoreResetService) private readonly reset: StoreResetService, @Inject(CONFIG) private readonly config: Config) {}
  @Get('reset') @Access({ permission: 'store.reset' })
  @Contract('Owner only (ADR 022): what a reset would delete for this store, and whether an upload in progress blocks it', undefined, previewSchema)
  preview(@Req() req: AppRequest) { return this.reset.preview(context(req, this.config)); }
  @Post('reset') @HttpCode(200) @Access({ permission: 'store.reset', stepUp: 'single' })
  @Contract('Owner only (ADR 022): delete all of the store\'s business data (products, uploads, comparisons, files, rules, offers); users, settings and saved layouts stay. Needs a fresh single-use code and the slug typed as confirmSlug; 409 while an upload is processed or the comparison is recalculated. Files are deleted by the worker shortly after.', dto.resetStoreData, resultSchema)
  run(@Req() req: AppRequest, @Body(new ZodPipe(dto.resetStoreData)) input: z.infer<typeof dto.resetStoreData>) {
    return this.reset.reset(context(req, this.config), input);
  }
}
