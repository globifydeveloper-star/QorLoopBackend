import { Body, Controller, Get, HttpCode, Inject, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { XLSX_CONTENT_TYPE } from '../../../../packages/core/src/upload/error-report.js';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, FileContract, ZodPipe } from '../http/contracts.js';
import { UploadsService } from './uploads.service.js';

@ApiTags('Uploads')
@ApiCookieAuth()
@Controller('api/uploads')
export class UploadsController {
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService, @Inject(CONFIG) private readonly config: Config) {}

  @Post() @HttpCode(200) @Access({ permission: 'uploads.upload' })
  @Contract('Create an upload record and a signed URL for a direct PUT to private storage (.xlsx/.xls/.csv, max 25 MB)', dto.createUpload)
  create(@Req() req: AppRequest, @Body(new ZodPipe(dto.createUpload)) input: z.infer<typeof dto.createUpload>) {
    return this.uploads.create(context(req, this.config), input);
  }

  @Post(':id/complete') @HttpCode(200) @Access({ permission: 'uploads.upload' })
  @Contract('Confirm the file reached storage and enqueue background processing (idempotent)')
  complete(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.uploads.complete(context(req, this.config), id);
  }

  @Get() @Access({ permission: 'uploads.view' })
  @Contract('Upload history', undefined, { type: 'array', items: { type: 'object' } })
  list(@Req() req: AppRequest) { return this.uploads.list(context(req, this.config)); }

  @Get(':id') @Access({ permission: 'uploads.view' })
  @Contract('Upload status, step and progress (poll every 2 s); includes headers and a suggested mapping when status is needs_mapping')
  get(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.uploads.get(context(req, this.config), id); }

  @Get(':id/review') @Access({ permission: 'uploads.view' })
  @Contract('The proposed change, by tab (price, stock, availability, new, unmatched), paginated')
  review(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(dto.reviewQuery)) query: z.infer<typeof dto.reviewQuery>) {
    return this.uploads.review(context(req, this.config), id, query);
  }

  @Get(':id/errors') @Access({ permission: 'uploads.view' })
  @Contract('Row errors (row, column, value, reason), 200 per page')
  errors(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Query('page', new ParseIntPipe({ optional: true })) page = 1) {
    return this.uploads.errors(context(req, this.config), id, Math.max(1, page));
  }

  @Get(':id/errors.xlsx') @Access({ permission: 'uploads.view' })
  @FileContract('All stored row errors (first 5,000) as an .xlsx download: a Summary sheet and a Row errors sheet', XLSX_CONTENT_TYPE)
  async errorsXlsx(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Res() reply: FastifyReply) {
    const file = await this.uploads.errorsXlsx(context(req, this.config), id);
    // the file name is reduced to [A-Za-z0-9._-] by errorReportFileName, so it is safe inside the quotes
    return reply
      .header('Content-Type', XLSX_CONTENT_TYPE)
      .header('Content-Disposition', `attachment; filename="${file.fileName}"`)
      .header('Cache-Control', 'no-store')
      .send(file.body);
  }

  @Post(':id/mapping') @HttpCode(200) @Access({ permission: 'uploads.map' })
  @Contract('Confirm a column mapping for an upload that needs one; optionally save it for the next file', dto.confirmMapping)
  mapping(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.confirmMapping)) input: z.infer<typeof dto.confirmMapping>) {
    return this.uploads.mapping(context(req, this.config), id, input);
  }

  @Post(':id/apply') @HttpCode(200) @Access({ permission: 'uploads.apply' })
  @Contract('Confirm and apply a reviewed upload (needs_review only; 409 otherwise). Returns the upload with status applying and enqueues the catalogue write; calling it again while applying or applied returns the record unchanged (idempotent)')
  apply(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.uploads.apply(context(req, this.config), id); }

  @Post(':id/discard') @HttpCode(200) @Access({ permission: 'uploads.discard' })
  @Contract('Discard an upload that is not applied; removes staging rows and the stored original')
  discard(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.uploads.discard(context(req, this.config), id); }
}
