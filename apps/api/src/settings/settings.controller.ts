import { Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { CONFIG } from '../tokens.js';
import { SettingsService } from './settings.service.js';

const rule = { type: 'object', properties: { mode: { type: 'string', enum: ['same', 'percent', 'amount', 'fixed'] }, value: { type: 'number' } } };
const rounding = { type: 'string', enum: ['exact', '0.05', '0.25', '0.50'] };
const settingsSchema = { type: 'object', properties: {
  profile: { type: 'object', properties: { name: { type: 'string' } } }, timeZone: { type: 'string', enum: ['Asia/Qatar'] }, currency: { type: 'string', enum: ['QAR'] },
  thresholds: { type: 'object', properties: { priceTolerance: { type: 'number' }, stockThreshold: { type: 'integer' }, staleHours: { type: 'integer' } } },
  security: { type: 'object', properties: { mfaRequiredForAll: { type: 'boolean' }, analystCanExport: { type: 'boolean' } } },
  pricing: { type: 'object', properties: {
    defaultRule: rule, rounding, perMarketplaceEnabled: { type: 'boolean' }, compareReferenceDefault: { type: 'string', enum: ['marketplace', 'erp'] },
    marketplaceRules: { type: 'array', items: { ...rule, properties: { ...rule.properties, marketplaceId: { type: 'string' }, rounding } } },
    order: { type: 'array', items: { type: 'string' } }, updatedAt: { type: ['string', 'null'], format: 'date-time' },
  } }, revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
} };

@ApiTags('Settings') @ApiCookieAuth()
@Controller('api/settings')
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService, @Inject(CONFIG) private readonly config: Config) {}
  @Get() @Access({ permission: 'settings.view' })
  @Contract('Tenant profile, thresholds, security and pricing; Asia/Qatar and QAR are read-only; revision is required on PUT', undefined, settingsSchema)
  get(@Req() req: AppRequest) { return this.settings.get(context(req, this.config)); }
  @Put() @Access({ permission: 'settings.edit' })
  @Contract('Update stored settings atomically; expectedRevision required, 409 on conflict; MFA policy is Owner only', dto.updateTenantSettings, settingsSchema)
  put(@Req() req: AppRequest, @Body(new ZodPipe(dto.updateTenantSettings)) input: z.infer<typeof dto.updateTenantSettings>) {
    return this.settings.put(context(req, this.config), input);
  }
  @Get('marketplaces') @Access({ permission: 'settings.view' })
  @Contract('Enabled marketplaces, latest applied upload and age in hours; read-only', undefined, {
    type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
      marketplaceId: { type: 'string', enum: ['talabat', 'snoonu', 'rafeeq', 'keeta'] }, enabled: { type: 'boolean', enum: [true] }, hasData: { type: 'boolean' },
      lastUploadAt: { type: ['string', 'null'], format: 'date-time' }, ageHours: { type: ['number', 'null'] },
    } } } },
  })
  marketplaces(@Req() req: AppRequest) { return this.settings.marketplaces(context(req, this.config)); }
}
