import { Body, Controller, Get, Inject, Param, Put, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { UPLOAD_SOURCES, type UploadSource } from '../../../../packages/core/src/upload/constants.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { CONFIG } from '../tokens.js';
import { TemplatesService } from './templates.service.js';

const nullableString = { type: ['string', 'null'] };
const dateOrNull = { type: ['string', 'null'], format: 'date-time' };
export const layoutSchema = {
  type: 'object', properties: {
    name: { type: 'string' }, version: { type: 'integer', description: 'Concurrency token for PUT (expectedVersion)' },
    builtIn: { type: 'boolean' }, editable: { type: 'boolean' },
    savedAt: { type: 'string', format: 'date-time' }, lastUsedAt: dateOrNull, usedByUploads: { type: 'integer', description: 'Uploads read with any version of this layout' },
    mapping: { type: 'object', additionalProperties: nullableString, description: 'Every field of the source -> header, null when unmapped' },
    mapped: { type: 'array', items: { type: 'string' } }, missingRequired: { type: 'array', items: { type: 'string' } },
    headers: { type: ['array', 'null'], items: { type: 'string' }, description: 'Columns of the last file read with this layout; null when none is on record (then headers are given by name)' },
  },
};
const outgoingSchema = {
  type: ['object', 'null'], description: 'Marketplaces only: what generated files write, from the latest applied upload (not the saved layout)',
  properties: {
    status: { type: 'string', enum: ['ready', 'not_ready'] }, reason: nullableString,
    basedOn: { type: ['object', 'null'], properties: {
      fileName: { type: 'string' }, appliedAt: dateOrNull,
      layout: { type: ['object', 'null'], properties: { name: { type: 'string' }, version: { type: 'integer' }, current: { type: 'boolean' } } },
    } },
    columns: { type: ['object', 'null'], properties: {
      matchBy: { type: 'object', properties: { field: { type: 'string', enum: ['marketplaceProductId', 'barcode1'] }, header: nullableString } },
      price: nullableString, availability: nullableString,
    } },
  },
};
export const templateEntrySchema = {
  type: 'object', properties: {
    source: { type: 'string', enum: [...UPLOAD_SOURCES] }, label: { type: 'string' },
    status: { type: 'string', enum: ['set_up', 'not_set_up'] }, reason: nullableString,
    fields: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' }, required: { type: 'boolean' } } } },
    layouts: { type: 'array', items: layoutSchema }, outgoing: outgoingSchema,
  },
};

@ApiTags('Templates') @ApiCookieAuth()
@Controller('api/templates')
export class TemplatesController {
  constructor(@Inject(TemplatesService) private readonly templates: TemplatesService, @Inject(CONFIG) private readonly config: Config) {}

  @Get() @Access({ permission: 'settings.view' })
  @Contract('Saved file layouts per source (ERP, Talabat, Snoonu, Rafeeq, Keeta) and, for marketplaces, the columns generated files write; read-only', undefined, {
    type: 'object', properties: { items: { type: 'array', items: templateEntrySchema } },
  })
  list(@Req() req: AppRequest) { return this.templates.list(context(req, this.config)); }

  @Put(':source') @Access({ permission: 'settings.edit' })
  @ApiParam({ name: 'source', enum: [...UPLOAD_SOURCES] })
  @Contract('Change the column a saved layout reads for the given fields (Owner/Admin). Writes the next version: only future uploads use it; applied uploads, generated files and comparisons are unchanged. 409 when expectedVersion is not the current version', dto.updateTemplate, templateEntrySchema)
  update(@Req() req: AppRequest, @Param('source', new ZodPipe(dto.uploadSource)) source: UploadSource, @Body(new ZodPipe(dto.updateTemplate)) input: z.infer<typeof dto.updateTemplate>) {
    return this.templates.update(context(req, this.config), source, input);
  }
}
