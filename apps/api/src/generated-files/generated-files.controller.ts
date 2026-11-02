import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { GeneratedFilesService } from './generated-files.service.js';

const count = { type: 'integer', minimum: 0 };
const date = { type: 'string', format: 'date-time' };
const previewSchema = {
  type: 'object', required: ['productCount', 'priceChanges', 'availabilityChanges', 'notInFile', 'largestPriceChange', 'firstRows', 'sourceFile', 'warnings', 'referenceUsed'],
  properties: {
    productCount: count, priceChanges: count, availabilityChanges: count, notInFile: count,
    largestPriceChange: { type: ['object', 'null'], properties: { name: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' } } },
    firstRows: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } } },
    sourceFile: { type: 'object', properties: { name: { type: 'string' }, uploadedAt: date } },
    warnings: { type: 'array', items: { type: 'string' } }, referenceUsed: { type: 'string', enum: ['erp', 'marketplace'] },
  },
};
const historySchema = {
  type: 'array', items: {
    type: 'object', properties: {
      id: { type: 'string', format: 'uuid' }, marketplaceId: { type: 'string', enum: ['talabat', 'snoonu', 'rafeeq', 'keeta'] },
      kind: { type: 'string', enum: ['stock', 'price', 'stock_price'] }, scope: { type: 'string', enum: ['mismatches', 'all'] },
      reference: { type: 'string', enum: ['erp', 'marketplace'] }, fileName: { type: 'string' }, productCount: count,
      generatedAt: date, generatedBy: { type: 'string' }, expiresAt: date,
    },
  },
};

@ApiTags('Generated files')
@ApiCookieAuth()
@Controller('api/generated-files')
export class GeneratedFilesController {
  constructor(@Inject(GeneratedFilesService) private readonly files: GeneratedFilesService, @Inject(CONFIG) private readonly config: Config) {}

  @Post('preview') @HttpCode(200) @Access({ permission: 'files.preview' })
  @Contract('Preview selected reconciliation rows in the latest applied marketplace file; no generated file is written', dto.generateMarketplaceFile, previewSchema)
  preview(@Req() req: AppRequest, @Body(new ZodPipe(dto.generateMarketplaceFile)) input: z.infer<typeof dto.generateMarketplaceFile>) {
    return this.files.preview(context(req, this.config), input);
  }
  @Post() @HttpCode(202) @Access({ permission: 'files.generate' })
  @Contract('Queue a marketplace file generation; identical selections within a minute share a job', dto.generateMarketplaceFile, { type: 'object', properties: { jobId: { type: 'string' } } }, 202)
  generate(@Req() req: AppRequest, @Body(new ZodPipe(dto.generateMarketplaceFile)) input: z.infer<typeof dto.generateMarketplaceFile>) {
    return this.files.generate(context(req, this.config), input);
  }
  @Get('jobs/:jobId') @Access({ permission: 'files.view' })
  @Contract('Generation job state (queued, running, done or failed); completed jobs include fileId', undefined, {
    type: 'object', required: ['state'], properties: { state: { type: 'string', enum: ['queued', 'running', 'done', 'failed'] }, fileId: { type: 'string', format: 'uuid' }, message: { type: 'string' } },
  })
  job(@Req() req: AppRequest, @Param('jobId', new ZodPipe(z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/))) jobId: string) {
    return this.files.job(context(req, this.config), jobId);
  }
  @Get() @Access({ permission: 'files.view' })
  @Contract('Generated files from the last 30 days, newest first', undefined, historySchema)
  history(@Req() req: AppRequest) { return this.files.history(context(req, this.config)); }

  @Get(':id/download') @Access({ permission: 'files.download' })
  @Contract('A short-lived signed download URL; expired files return 404', undefined, {
    type: 'object', required: ['url', 'fileName', 'expiresAt'], properties: { url: { type: 'string', format: 'uri' }, fileName: { type: 'string' }, expiresAt: date },
  })
  download(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.files.download(context(req, this.config), id); }
}
