// Plan step 10 (docs/plans/onboarding-redesign-backend.md, Part 2): the guided checklist and the essentials gate.
import { describe, expect, it } from '@jest/globals';
import { CHECKLIST_IDS, ESSENTIAL_IDS, onboardingChecklist, type ChecklistFacts } from '../onboarding.js';
import { MARKETPLACES } from '../constants.js';

const at = '2026-11-20T09:00:00.000Z', later = '2026-11-20T10:00:00.000Z';
function facts(over: Partial<ChecklistFacts> = {}, marketplaces: Partial<ChecklistFacts['marketplaces'][number]>[] = []): ChecklistFacts {
  return {
    marketplaces: MARKETPLACES.map((marketplaceId, i) => ({ marketplaceId, enabled: false, explicit: false, appliedAt: null, pendingUpload: null, ...marketplaces[i] })),
    erp: { appliedAt: null, pendingUpload: null },
    priceSource: { source: null, marketplaceId: null, confirmedAt: null },
    comparison: { doneAt: null, lastFailureAt: null },
    thresholds: { priceTolerance: 0, stockThreshold: 0, staleHours: 12 },
    teamInvitationAt: null, viewerMfa: true, ...over,
  };
}
const status = (c: ReturnType<typeof onboardingChecklist>) => Object.fromEntries(c.checklist.map(i => [i.id, i.status]));
const talabatOn = { enabled: true, explicit: true };
/** Everything an essential needs, Talabat only. */
const ready = () => facts({
  erp: { appliedAt: at, pendingUpload: null }, priceSource: { source: 'erp_markup', marketplaceId: null, confirmedAt: at }, comparison: { doneAt: later, lastFailureAt: null },
}, [{ ...talabatOn, appliedAt: at }, { explicit: true }, { explicit: true }, { explicit: true }]);

describe('onboarding checklist', () => {
  it('starts at the store details, in the approved order, with every essential missing', () => {
    const c = onboardingChecklist(facts(), 'owner');
    expect(c.checklist.map(i => i.id)).toEqual([...CHECKLIST_IDS]);
    expect(status(c)).toEqual({ store_details: 'next', erp_upload: 'todo', marketplace_uploads: 'todo', price_source: 'todo', first_comparison: 'todo',
      thresholds: 'defaults', authenticator_app: 'done', invite_team: 'todo' });
    expect(c.essentials).toMatchObject({ complete: false, percent: 0 });
    expect(c.essentials.missing.map(m => m.id)).toEqual([...ESSENTIAL_IDS]);
    expect(c.checklist.filter(i => i.required).map(i => i.id)).toEqual([...ESSENTIAL_IDS]);
  });
  it('opens the Dashboard only when all five essentials are done; optional items never count', () => {
    const c = onboardingChecklist(ready(), 'owner');
    expect(c.essentials).toEqual({ complete: true, percent: 100, missing: [] });
    expect(c.checklist.find(i => i.id === 'marketplace_uploads')!.doneAt).toBe(at);
    for (const missing of [
      { erp: { appliedAt: null, pendingUpload: null } }, { priceSource: { source: null, marketplaceId: null, confirmedAt: null } },
      { comparison: { doneAt: null, lastFailureAt: null } },
    ] as Partial<ChecklistFacts>[]) {
      const partial = onboardingChecklist({ ...ready(), ...missing }, 'owner');
      expect(partial.essentials.complete).toBe(false);
      expect(partial.essentials.percent).toBe(80);
    }
  });
  it('requires a file for every enabled marketplace, naming the ones still missing and any unfinished upload', () => {
    const pending = { id: 'u1', status: 'needs_mapping', updatedAt: at };
    const c = onboardingChecklist(facts({}, [{ ...talabatOn, appliedAt: at }, { ...talabatOn, pendingUpload: pending }, { enabled: true, explicit: true }]), 'owner');
    const item = c.checklist.find(i => i.id === 'marketplace_uploads')!;
    expect(item.status).toBe('todo');
    expect(item.detail.items).toEqual([
      { marketplaceId: 'talabat', status: 'done', doneAt: at, pendingUpload: null },
      { marketplaceId: 'snoonu', status: 'pending', doneAt: null, pendingUpload: pending },
      { marketplaceId: 'rafeeq', status: 'todo', doneAt: null, pendingUpload: null },
    ]);
    expect(c.essentials.missing.find(m => m.id === 'marketplace_uploads')!.message)
      .toBe('Upload and apply a file for Snoonu (your file is waiting for column mapping), Rafeeq');
    // A switched-off marketplace with data is not required and not listed.
    const off = onboardingChecklist(facts({}, [{ ...talabatOn, appliedAt: at }, { explicit: true, appliedAt: at }]), 'owner');
    expect(off.checklist.find(i => i.id === 'marketplace_uploads')!.status).toBe('done');
  });
  it('treats a store without switch rows by its applied files (stores from before the switch existed)', () => {
    const legacy = onboardingChecklist(facts({}, [{ enabled: true, appliedAt: at }]), 'owner');
    expect(legacy.checklist.find(i => i.id === 'store_details')!.status).toBe('done');
    // With switch rows, only an explicit enabled one counts.
    const explicitOff = onboardingChecklist(facts({}, [{ enabled: true, appliedAt: at }, { explicit: true }]), 'owner');
    expect(explicitOff.checklist.find(i => i.id === 'store_details')!.status).toBe('next');
  });
  it('shows the ERP file to continue when one is unfinished', () => {
    const c = onboardingChecklist(facts({ erp: { appliedAt: null, pendingUpload: { id: 'e1', status: 'rejected', updatedAt: at } } }), 'owner');
    expect(c.checklist.find(i => i.id === 'erp_upload')!.detail.pendingUpload).toMatchObject({ id: 'e1' });
    expect(c.essentials.missing.find(m => m.id === 'erp_upload')!.message).toBe('Your ERP file was rejected; upload a corrected file');
  });
  it('reports the comparison as waiting, failed or done, and never makes it the next step', () => {
    const base = facts({ erp: { appliedAt: at, pendingUpload: null } }, [{ ...talabatOn, appliedAt: at }]);
    const waiting = onboardingChecklist(base, 'owner');
    expect(status(waiting).first_comparison).toBe('waiting');
    expect(status(waiting).price_source).toBe('next');
    const failed = onboardingChecklist({ ...base, comparison: { doneAt: null, lastFailureAt: later } }, 'owner');
    expect(status(failed).first_comparison).toBe('failed');
    expect(failed.checklist.find(i => i.id === 'first_comparison')!.detail.reason).toMatch(/retried automatically/);
    expect(onboardingChecklist(facts(), 'owner').checklist.find(i => i.id === 'first_comparison')!.canAct).toBe(false);
  });
  it('offers adoption only from enabled marketplaces with an applied file', () => {
    const c = onboardingChecklist(facts({}, [{ ...talabatOn, appliedAt: at }, talabatOn, { explicit: true, appliedAt: at }]), 'owner');
    expect(c.checklist.find(i => i.id === 'price_source')!.detail.canAdoptFrom).toEqual(['talabat']);
  });
  it('shows customised thresholds and the optional items', () => {
    const c = onboardingChecklist(facts({ thresholds: { priceTolerance: 0.25, stockThreshold: 0, staleHours: 12 }, teamInvitationAt: at, viewerMfa: false }), 'owner');
    expect(status(c)).toMatchObject({ thresholds: 'customised', invite_team: 'done', authenticator_app: 'todo' });
  });
  it('filters the checklist by role; every role gets the essentials', () => {
    const f = facts();
    const roles = { owner: CHECKLIST_IDS.length, admin: CHECKLIST_IDS.length - 1, catalogue_manager: 2, analyst: 0 } as const;
    for (const [role, count] of Object.entries(roles) as [keyof typeof roles, number][]) {
      const c = onboardingChecklist(f, role);
      expect(c.checklist).toHaveLength(count);
      expect(c.essentials.missing).toHaveLength(5);
    }
    expect(onboardingChecklist(f, 'catalogue_manager').checklist.map(i => [i.id, i.canAct])).toEqual([['erp_upload', true], ['marketplace_uploads', true]]);
    const admin = onboardingChecklist(f, 'admin').checklist;
    expect(admin.find(i => i.id === 'price_source')!.canAct).toBe(true);
    expect(admin.some(i => i.id === 'authenticator_app')).toBe(false);
  });
});
