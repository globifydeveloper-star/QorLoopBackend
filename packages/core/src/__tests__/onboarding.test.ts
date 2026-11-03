import { describe, expect, it } from '@jest/globals';
import { emptyOnboardingProgress, onboardingProgress, ONBOARDING_STEP_IDS, type OnboardingFacts } from '../onboarding.js';

const at = '2026-11-03T09:00:00.000Z';
const yes = { done: true, doneAt: at };
const no = { done: false, doneAt: null };
function blank(): OnboardingFacts {
  return { ownerMfa: no, erpUpload: no, marketplaces: [], comparison: no, teamInvitation: no, pricingSettings: no, generatedFile: no };
}

describe('derived onboarding', () => {
  it('starts at security, in the approved order, with no profile/category/skip state', () => {
    const progress = onboardingProgress(blank());
    expect(progress.steps.map(s => s.id)).toEqual([...ONBOARDING_STEP_IDS]);
    expect(progress.steps.map(s => s.status)).toEqual(['next', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(progress).toMatchObject({ percent: 0, nextStepId: 'owner_mfa', complete: false });
    expect(progress.steps.every(s => s.doneAt === null && s.action.kind === 'navigate' && s.description.length > 0)).toBe(true);
  });

  it.each(Array.from({ length: 16 }, (_, mask) => mask))('handles required evidence arriving in any order (mask %i)', mask => {
    const facts = blank();
    facts.ownerMfa = mask & 1 ? { done: true, doneAt: null } : no;
    facts.erpUpload = mask & 2 ? yes : no;
    facts.marketplaces = mask & 4 ? [{ marketplaceId: 'snoonu', appliedAt: at }] : [];
    facts.comparison = mask & 8 ? yes : no;
    const progress = onboardingProgress(facts);
    const done = [1, 2, 4, 8].map(bit => Boolean(mask & bit));
    const firstMissing = done.indexOf(false);
    expect(progress.percent).toBe(done.filter(Boolean).length * 25);
    expect(progress.complete).toBe(mask === 15);
    expect(progress.nextStepId).toBe(firstMissing < 0 ? null : ONBOARDING_STEP_IDS[firstMissing]);
    expect(progress.steps.slice(0, 4).map(s => s.status)).toEqual(done.map((d, i) => d ? 'done' : i === firstMissing ? 'next' : 'todo'));
    expect(progress.steps[0].doneAt).toBeNull();
    facts.teamInvitation = yes; facts.pricingSettings = yes; facts.generatedFile = yes;
    const withOptional = onboardingProgress(facts);
    expect([withOptional.percent, withOptional.complete, withOptional.nextStepId]).toEqual([progress.percent, progress.complete, progress.nextStepId]);
    expect(withOptional.steps.slice(4).map(s => s.status)).toEqual(['done', 'done', 'done']);
  });

  it('returns each marketplace in canonical order and one applied marketplace satisfies the required step', () => {
    const progress = onboardingProgress({ ...blank(), marketplaces: [
      { marketplaceId: 'snoonu', appliedAt: at }, { marketplaceId: 'talabat', appliedAt: '2026-11-03T08:00:00.000Z' },
    ] });
    expect(progress.marketplaces).toEqual([
      { marketplaceId: 'talabat', applied: true, doneAt: '2026-11-03T08:00:00.000Z' },
      { marketplaceId: 'snoonu', applied: true, doneAt: at },
      { marketplaceId: 'rafeeq', applied: false, doneAt: null },
      { marketplaceId: 'keeta', applied: false, doneAt: null },
    ]);
    expect(progress.steps[2]).toMatchObject({ status: 'done', doneAt: '2026-11-03T08:00:00.000Z' });
  });

  it('does not keep a timestamp for an unmet condition or mutate evidence', () => {
    const facts = { ...blank(), pricingSettings: { done: false, doneAt: at } };
    const copy = structuredClone(facts);
    expect(onboardingProgress(facts).steps[5]).toMatchObject({ status: 'todo', doneAt: null });
    expect(facts).toEqual(copy);
    expect(emptyOnboardingProgress()).toEqual({ steps: [], marketplaces: [], percent: 0, nextStepId: null, complete: false });
  });
});
