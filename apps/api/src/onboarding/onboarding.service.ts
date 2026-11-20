import { Inject, Injectable } from '@nestjs/common';
import { emptyOnboardingProgress, onboardingChecklist, onboardingProgress } from '../../../../packages/core/src/onboarding.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';

@Injectable()
export class OnboardingService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /**
   * The ADR 015 wizard fields (unchanged; Owner and Admin only) plus the guided checklist and the essentials gate
   * (plan step 10): every role gets `essentials`, the checklist is filtered by role.
   */
  get(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'settings.view' }, async (data, p) => {
      const facts = await data.onboarding.facts();
      const wizard = p.member.role === 'owner' || p.member.role === 'admin' ? onboardingProgress(facts) : emptyOnboardingProgress();
      return { ...wizard, ...onboardingChecklist(await data.onboarding.checklistFacts(facts, p.user.id), p.member.role) };
    });
  }
}
