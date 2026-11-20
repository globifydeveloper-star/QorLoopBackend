import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Config } from '../../../../packages/shared/src/config.js';
import { MARKETPLACES } from '../../../../packages/core/src/constants.js';
import { CHECKLIST_IDS, ESSENTIAL_IDS, ONBOARDING_STEP_IDS } from '../../../../packages/core/src/onboarding.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract } from '../http/contracts.js';
import { CONFIG } from '../tokens.js';
import { OnboardingService } from './onboarding.service.js';

const timestamp = { type: ['string', 'null'], format: 'date-time' };
const pendingUpload = {
  type: ['object', 'null'], additionalProperties: false, required: ['id', 'status', 'updatedAt'],
  description: 'The newest upload of this source when it is not applied: in progress, or rejected/failed', properties: {
    id: { type: 'string', format: 'uuid' }, status: { type: 'string' }, updatedAt: { type: 'string', format: 'date-time' },
  },
};
export const onboardingSchema = {
  type: 'object', additionalProperties: false, required: ['steps', 'percent', 'nextStepId', 'complete', 'marketplaces', 'checklist', 'essentials'],
  properties: {
    checklist: { type: 'array', description: 'Guided checklist. Owner: all items; Admin: all but authenticator_app; Catalogue Manager: erp_upload and marketplace_uploads; Analyst: none', items: {
      type: 'object', additionalProperties: false, required: ['id', 'required', 'status', 'doneAt', 'canAct', 'detail'], properties: {
        id: { type: 'string', enum: [...CHECKLIST_IDS] }, required: { type: 'boolean' },
        status: { type: 'string', enum: ['done', 'next', 'todo', 'waiting', 'failed', 'defaults', 'customised'] }, doneAt: timestamp,
        canAct: { type: 'boolean', description: "The caller's role may do this step" },
        detail: { type: 'object', description: 'store_details: enabledMarketplaces; erp_upload: pendingUpload; marketplace_uploads: items[{marketplaceId, status done|pending|todo, doneAt, pendingUpload}]; price_source: priceSource, marketplaceId, canAdoptFrom; first_comparison: reason; thresholds: priceTolerance, stockThreshold, staleHours', properties: {
          enabledMarketplaces: { type: 'array', items: { type: 'string', enum: [...MARKETPLACES] } }, pendingUpload,
          items: { type: 'array', items: { type: 'object', properties: { marketplaceId: { type: 'string', enum: [...MARKETPLACES] }, status: { type: 'string', enum: ['done', 'pending', 'todo'] }, doneAt: timestamp, pendingUpload } } },
          priceSource: { type: ['string', 'null'], enum: ['erp_markup', 'adopt', null] }, marketplaceId: { type: ['string', 'null'] },
          canAdoptFrom: { type: 'array', items: { type: 'string', enum: [...MARKETPLACES] } }, reason: { type: ['string', 'null'] },
          priceTolerance: { type: 'number' }, stockThreshold: { type: 'integer' }, staleHours: { type: 'integer' },
        } },
      },
    } },
    essentials: { type: 'object', additionalProperties: false, required: ['complete', 'percent', 'missing'], description: 'The Dashboard opens when complete; every role receives it', properties: {
      complete: { type: 'boolean' }, percent: { type: 'integer', enum: [0, 20, 40, 60, 80, 100] },
      missing: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'message'], properties: {
        id: { type: 'string', enum: [...ESSENTIAL_IDS] }, message: { type: 'string' },
      } } },
    } },
    steps: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'title', 'description', 'required', 'status', 'doneAt', 'action'],
      properties: {
        id: { type: 'string', enum: [...ONBOARDING_STEP_IDS] }, title: { type: 'string' }, description: { type: 'string' }, required: { type: 'boolean' },
        status: { type: 'string', enum: ['done', 'next', 'todo'] }, doneAt: timestamp,
        action: { type: 'object', additionalProperties: false, required: ['kind', 'target'], properties: {
          kind: { type: 'string', enum: ['navigate'] },
          target: { type: 'string', enum: ['settings.security', 'uploads.erp', 'uploads.marketplace', 'dashboard', 'team.invite', 'settings.pricing', 'generated-files'] },
        } },
      },
    } },
    percent: { type: 'integer', enum: [0, 25, 50, 75, 100] },
    nextStepId: { type: ['string', 'null'], enum: [...ONBOARDING_STEP_IDS.slice(0, 4), null] }, complete: { type: 'boolean' },
    marketplaces: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['marketplaceId', 'applied', 'doneAt'], properties: {
        marketplaceId: { type: 'string', enum: [...MARKETPLACES] }, applied: { type: 'boolean' }, doneAt: timestamp,
      },
    } },
  },
};

@ApiTags('Onboarding') @ApiCookieAuth()
@Controller('api/onboarding')
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService, @Inject(CONFIG) private readonly config: Config) {}

  @Get() @Access({ permission: 'settings.view' })
  @Contract('Derived onboarding progress. steps/percent/nextStepId/complete/marketplaces: the ADR 015 wizard (Owner/Admin; other roles empty). checklist/essentials: the guided checklist filtered by role and the Dashboard gate (five essentials) for every role', undefined, onboardingSchema)
  get(@Req() req: AppRequest) { return this.onboarding.get(context(req, this.config)); }
}
