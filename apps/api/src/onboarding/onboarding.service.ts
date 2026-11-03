import { Inject, Injectable } from '@nestjs/common';
import { emptyOnboardingProgress, onboardingProgress } from '../../../../packages/core/src/onboarding.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';

@Injectable()
export class OnboardingService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  get(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'settings.view' }, async (data, p) => {
      if (p.member.role !== 'owner' && p.member.role !== 'admin') return emptyOnboardingProgress();
      return onboardingProgress(await data.onboarding.facts());
    });
  }
}
