import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { CONFIG } from '../tokens.js';
import { ActivityService } from './activity.service.js';

const scalar = { type: ['string', 'number', 'boolean', 'object', 'null'] };
const pageProperties = {
  items: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string', format: 'uuid' }, time: { type: 'string', format: 'date-time' },
    actor: { type: 'object', properties: { id: { type: ['string', 'null'], format: 'uuid' }, name: { type: 'string' }, email: { type: ['string', 'null'] } } },
    type: { type: 'string' }, group: { type: 'string', enum: ['price', 'stock_uploads', 'catalogue', 'team_security'] }, summary: { type: 'string' },
    beforeAfter: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, before: scalar, after: scalar } } },
    scope: { type: 'string', enum: ['tenant', 'product'] }, productId: { type: ['string', 'null'], format: 'uuid' }, uploadId: { type: ['string', 'null'], format: 'uuid' },
  } } }, nextCursor: { type: ['string', 'null'] },
};

@ApiTags('Activity') @ApiCookieAuth()
@Controller('api')
export class ActivityController {
  constructor(@Inject(ActivityService) private readonly activity: ActivityService, @Inject(CONFIG) private readonly config: Config) {}
  @Get('activity') @Access({ permission: 'activity.view' })
  @ApiQuery({ name: 'eventType', required: false, enum: ['price', 'stock_uploads', 'catalogue', 'team_security'] })
  @ApiQuery({ name: 'productId', required: false }) @ApiQuery({ name: 'actorId', required: false, description: 'User UUID or system' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false })
  @Contract('Safe activity summaries, newest first; keyset pagination by exact UTC timestamp and id', undefined, { type: 'object', properties: pageProperties })
  list(@Req() req: AppRequest, @Query(new ZodPipe(dto.activityQuery)) query: z.infer<typeof dto.activityQuery>) {
    return this.activity.list(context(req, this.config), query);
  }
  @Get('products/:id/history') @Access({ permission: 'activity.view' })
  @Contract('Product changes and indexed bulk membership plus clearly labelled store-wide upload summaries; includes coverageNotice', undefined,
    { type: 'object', properties: { ...pageProperties, coverageNotice: { type: 'string' } } })
  history(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(dto.activityQuery)) query: z.infer<typeof dto.activityQuery>) {
    return this.activity.list(context(req, this.config), query, id);
  }
}
