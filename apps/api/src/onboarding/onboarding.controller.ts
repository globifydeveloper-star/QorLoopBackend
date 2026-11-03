import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Config } from '../../../../packages/shared/src/config.js';
import { MARKETPLACES } from '../../../../packages/core/src/constants.js';
import { ONBOARDING_STEP_IDS } from '../../../../packages/core/src/onboarding.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract } from '../http/contracts.js';
import { CONFIG } from '../tokens.js';
import { OnboardingService } from './onboarding.service.js';

const timestamp = { type: ['string', 'null'], format: 'date-time' };
export const onboardingSchema = {
  type: 'object', additionalProperties: false, required: ['steps', 'percent', 'nextStepId', 'complete', 'marketplaces'],
  properties: {
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
  @Contract('Derived onboarding progress; Owner/Admin wizard, other roles empty; only four required steps count toward completion', undefined, onboardingSchema)
  get(@Req() req: AppRequest) { return this.onboarding.get(context(req, this.config)); }
}
