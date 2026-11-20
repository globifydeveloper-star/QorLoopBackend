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
    { id: 'owner_mfa', title: 'Secure your account', description: 'An active Owner signs in with two-step verification (an emailed code or an authenticator app).', required: true, target: 'settings.security', evidence: facts.ownerMfa },
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

// ───────────── Guided checklist (docs/plans/onboarding-redesign-backend.md, Part 2) ─────────────

export const CHECKLIST_IDS = ['store_details', 'erp_upload', 'marketplace_uploads', 'price_source', 'first_comparison', 'thresholds', 'authenticator_app', 'invite_team'] as const;
export type ChecklistId = typeof CHECKLIST_IDS[number];
/** The essentials: the Dashboard opens when all of them are done. */
export const ESSENTIAL_IDS = ['store_details', 'erp_upload', 'marketplace_uploads', 'price_source', 'first_comparison'] as const satisfies readonly ChecklistId[];
export type ChecklistStatus = 'done' | 'next' | 'todo' | 'waiting' | 'failed' | 'defaults' | 'customised';
/** The newest upload of a source when it is not applied: still in progress, or rejected/failed. */
export interface PendingUpload { id: string; status: string; updatedAt: string }
export interface ChecklistFacts {
  /** Every marketplace in canonical order. explicit: the store has a switch row for it. appliedAt: an applied upload. */
  marketplaces: { marketplaceId: MarketplaceId; enabled: boolean; explicit: boolean; appliedAt: string | null; pendingUpload: PendingUpload | null }[];
  erp: { appliedAt: string | null; pendingUpload: PendingUpload | null };
  priceSource: { source: 'erp_markup' | 'adopt' | null; marketplaceId: string | null; confirmedAt: string | null };
  /** doneAt: a computed comparison with matched data. lastFailureAt: a recon failure newer than the last computation. */
  comparison: { doneAt: string | null; lastFailureAt: string | null };
  thresholds: { priceTolerance: number; stockThreshold: number; staleHours: number };
  teamInvitationAt: string | null;
  /** The signed-in user's own authenticator app. */
  viewerMfa: boolean;
}
export interface ChecklistItem {
  id: ChecklistId;
  required: boolean;
  status: ChecklistStatus;
  doneAt: string | null;
  /** The signed-in user's role may do this step (false for the system's own comparison step). */
  canAct: boolean;
  detail: Record<string, unknown>;
}
export interface Checklist {
  checklist: ChecklistItem[];
  essentials: { complete: boolean; percent: number; missing: { id: ChecklistId; message: string }[] };
}
type ChecklistRole = 'owner' | 'admin' | 'catalogue_manager' | 'analyst';

const NAMES: Record<MarketplaceId, string> = { talabat: 'Talabat', snoonu: 'Snoonu', rafeeq: 'Rafeeq', keeta: 'Keeta' };
const PENDING_TEXT: Record<string, string> = {
  uploading: 'is still uploading', uploaded: 'is being checked', processing: 'is being checked', needs_mapping: 'is waiting for column mapping',
  needs_review: 'is waiting for your review', applying: 'is being applied', rejected: 'was rejected; upload a corrected file', failed: 'failed; upload it again',
};
const pendingText = (u: PendingUpload) => PENDING_TEXT[u.status] ?? 'is in progress';
const MANAGERS: readonly ChecklistRole[] = ['owner', 'admin'];
const UPLOADERS: readonly ChecklistRole[] = ['owner', 'admin', 'catalogue_manager'];

/**
 * The guided checklist and the essentials gate, derived from evidence only (no progress storage except the explicit
 * price-source choice). Owners and Admins get every item; Catalogue Managers the two upload items; Analysts none.
 * Every role gets `essentials`, so a screen can say what is still missing.
 */
export function onboardingChecklist(facts: ChecklistFacts, role: ChecklistRole): Checklist {
  const enabled = facts.marketplaces.filter(m => m.enabled);
  const anyExplicit = facts.marketplaces.some(m => m.explicit);
  // Stores from before the switch existed have no switch rows: marketplaces with applied files count as chosen.
  const storeDone = anyExplicit ? facts.marketplaces.some(m => m.explicit && m.enabled) : enabled.length > 0;
  const uploadsDone = enabled.length > 0 && enabled.every(m => m.appliedAt);
  const erpDone = facts.erp.appliedAt !== null;
  const compareStatus: ChecklistStatus = facts.comparison.doneAt ? 'done' : facts.comparison.lastFailureAt ? 'failed'
    : erpDone && enabled.some(m => m.appliedAt) ? 'waiting' : 'todo';
  const thresholdsDefault = facts.thresholds.priceTolerance === 0 && facts.thresholds.stockThreshold === 0 && facts.thresholds.staleHours === 12;
  const latest = (dates: (string | null)[]) => dates.every(Boolean) && dates.length ? [...dates as string[]].sort().at(-1)! : null;

  const items: (ChecklistItem & { message: string })[] = [
    { id: 'store_details', required: true, status: storeDone ? 'done' : 'todo', doneAt: null, canAct: MANAGERS.includes(role),
      detail: { enabledMarketplaces: enabled.map(m => m.marketplaceId) }, message: 'Choose the marketplaces your store uses' },
    { id: 'erp_upload', required: true, status: erpDone ? 'done' : 'todo', doneAt: facts.erp.appliedAt, canAct: UPLOADERS.includes(role),
      detail: { pendingUpload: facts.erp.pendingUpload },
      message: facts.erp.pendingUpload ? `Your ERP file ${pendingText(facts.erp.pendingUpload)}` : 'Upload and apply your ERP file' },
    { id: 'marketplace_uploads', required: true, status: uploadsDone ? 'done' : 'todo', doneAt: uploadsDone ? latest(enabled.map(m => m.appliedAt)) : null,
      canAct: UPLOADERS.includes(role),
      detail: { items: enabled.map(m => ({ marketplaceId: m.marketplaceId, status: m.appliedAt ? 'done' : m.pendingUpload ? 'pending' : 'todo', doneAt: m.appliedAt, pendingUpload: m.pendingUpload })) },
      message: enabled.length === 0 ? 'Choose at least one marketplace, then upload its file'
        : 'Upload and apply a file for ' + enabled.filter(m => !m.appliedAt).map(m => NAMES[m.marketplaceId] + (m.pendingUpload ? ` (your file ${pendingText(m.pendingUpload)})` : '')).join(', ') },
    { id: 'price_source', required: true, status: facts.priceSource.source ? 'done' : 'todo', doneAt: facts.priceSource.confirmedAt, canAct: MANAGERS.includes(role),
      detail: { priceSource: facts.priceSource.source, marketplaceId: facts.priceSource.marketplaceId,
        canAdoptFrom: enabled.filter(m => m.appliedAt).map(m => m.marketplaceId) },
      message: 'Choose how your prices are set' },
    { id: 'first_comparison', required: true, status: compareStatus, doneAt: facts.comparison.doneAt, canAct: false,
      detail: { reason: compareStatus === 'failed' ? 'The comparison could not be computed. It is retried automatically; if this stays, contact support.'
        : compareStatus === 'waiting' ? 'Your files are being compared' : null },
      message: compareStatus === 'failed' ? 'The first comparison could not be computed yet' : compareStatus === 'waiting' ? 'Your first comparison is being prepared'
        : 'The first comparison runs once the ERP file and a marketplace file are applied' },
    { id: 'thresholds', required: false, status: thresholdsDefault ? 'defaults' : 'customised', doneAt: null, canAct: MANAGERS.includes(role),
      detail: { ...facts.thresholds }, message: '' },
    { id: 'authenticator_app', required: false, status: facts.viewerMfa ? 'done' : 'todo', doneAt: null, canAct: true, detail: {}, message: '' },
    { id: 'invite_team', required: false, status: facts.teamInvitationAt ? 'done' : 'todo', doneAt: facts.teamInvitationAt, canAct: MANAGERS.includes(role), detail: {}, message: '' },
  ];
  // At most one next: the first essential that is simply to do (waiting and failed keep their status).
  const next = items.find(i => i.required && i.status === 'todo');
  if (next) next.status = 'next';
  const essentials = items.filter(i => i.required);
  const done = essentials.filter(i => i.status === 'done').length;
  const visible = role === 'owner' ? items : role === 'admin' ? items.filter(i => i.id !== 'authenticator_app')
    : role === 'catalogue_manager' ? items.filter(i => i.id === 'erp_upload' || i.id === 'marketplace_uploads') : [];
  return {
    checklist: visible.map(({ message: _message, ...item }) => item),
    essentials: {
      complete: done === essentials.length, percent: Math.floor(done * 100 / essentials.length),
      missing: essentials.filter(i => i.status !== 'done').map(i => ({ id: i.id, message: i.message })),
    },
  };
}
