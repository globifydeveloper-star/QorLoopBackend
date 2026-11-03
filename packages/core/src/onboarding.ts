import { MARKETPLACES, type MarketplaceId } from './constants.js';

export const ONBOARDING_STEP_IDS = ['owner_mfa', 'erp_upload', 'marketplace_upload', 'first_comparison', 'invite_team', 'pricing_settings', 'generated_file'] as const;
export type OnboardingStepId = typeof ONBOARDING_STEP_IDS[number];
export type OnboardingStatus = 'done' | 'next' | 'todo';
export interface OnboardingEvidence { done: boolean; doneAt: string | null }
export interface OnboardingFacts {
  ownerMfa: OnboardingEvidence;
  erpUpload: OnboardingEvidence;
  marketplaces: { marketplaceId: MarketplaceId; appliedAt: string | null }[];
  comparison: OnboardingEvidence;
  teamInvitation: OnboardingEvidence;
  pricingSettings: OnboardingEvidence;
  generatedFile: OnboardingEvidence;
}
export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  description: string;
  required: boolean;
  status: OnboardingStatus;
  doneAt: string | null;
  action: { kind: 'navigate'; target: string };
}
export interface OnboardingProgress {
  steps: OnboardingStep[];
  percent: number;
  nextStepId: OnboardingStepId | null;
  complete: boolean;
  marketplaces: { marketplaceId: MarketplaceId; applied: boolean; doneAt: string | null }[];
}

/** No storage/click state: completion and the next required step are always derived from evidence. */
export function onboardingProgress(facts: OnboardingFacts): OnboardingProgress {
  const marketplaces = MARKETPLACES.map(marketplaceId => {
    const at = facts.marketplaces.find(m => m.marketplaceId === marketplaceId)?.appliedAt ?? null;
    return { marketplaceId, applied: at !== null, doneAt: at };
  });
  const marketplaceDates = marketplaces.flatMap(m => m.doneAt ? [m.doneAt] : []).sort();
  const definitions: { id: OnboardingStepId; title: string; description: string; required: boolean; target: string; evidence: OnboardingEvidence }[] = [
    { id: 'owner_mfa', title: 'Secure your account', description: 'Enable two-step verification for an active Owner account.', required: true, target: 'settings.security', evidence: facts.ownerMfa },
    { id: 'erp_upload', title: 'Upload your ERP file', description: 'Upload and apply your ERP file to bring your products into Qorloop.', required: true, target: 'uploads.erp', evidence: facts.erpUpload },
    { id: 'marketplace_upload', title: 'Upload at least one marketplace file', description: 'Upload and apply a file from Talabat, Snoonu, Rafeeq or Keeta.', required: true, target: 'uploads.marketplace', evidence: { done: marketplaceDates.length > 0, doneAt: marketplaceDates[0] ?? null } },
    { id: 'first_comparison', title: 'Review the first comparison', description: 'Open Dashboard when a computed comparison contains matched marketplace data.', required: true, target: 'dashboard', evidence: facts.comparison },
    { id: 'invite_team', title: 'Invite your team', description: 'Invite a teammate to work with you. This is optional.', required: false, target: 'team.invite', evidence: facts.teamInvitation },
    { id: 'pricing_settings', title: 'Review pricing settings', description: 'Configure pricing settings if your shop needs different values from the defaults. This is optional.', required: false, target: 'settings.pricing', evidence: facts.pricingSettings },
    { id: 'generated_file', title: 'Generate your first corrected file', description: 'Generate a file for your marketplace when you have changes to send. This is optional.', required: false, target: 'generated-files', evidence: facts.generatedFile },
  ];
  const required = definitions.filter(s => s.required);
  const nextStepId = required.find(s => !s.evidence.done)?.id ?? null;
  return {
    steps: definitions.map(({ target, evidence, ...step }) => ({ ...step,
      status: evidence.done ? 'done' : step.id === nextStepId ? 'next' : 'todo',
      doneAt: evidence.done ? evidence.doneAt : null, action: { kind: 'navigate', target },
    })),
    percent: required.filter(s => s.evidence.done).length * 25,
    nextStepId, complete: nextStepId === null, marketplaces,
  };
}

/** Other roles do not participate in the Owner/Admin wizard; complete is not a tenant-completion assertion. */
export function emptyOnboardingProgress(): OnboardingProgress {
  return { steps: [], percent: 0, nextStepId: null, complete: false, marketplaces: [] };
}
