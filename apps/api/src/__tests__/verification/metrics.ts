/** Accuracy bookkeeping for the verification harness. No product imports. */
export type Check = {
  feature: string;
  dataset: string;
  caseId: string;
  /** null when the feature has no "problem" notion (value-only, e.g. the expected price) */
  expectedProblem: boolean | null;
  actualProblem: boolean | null;
  expected: unknown;
  actual: unknown;
};

export type FeatureMetrics = {
  feature: string; cases: number; exact: number; found: number; missed: number; falseAlarms: number; wrongValues: number;
  exactMatchRate: number; precision: number | null; recall: number | null;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * found = expected problem and flagged; missed = expected problem not flagged; false alarm = flagged without an expected
 * problem; wrong value = the compared value differs (counted whether or not the flag agreed); exact = flag and value agree.
 * precision = found / (found + false alarms); recall = found / (found + missed); null when the denominator is 0.
 */
export function summarise(checks: Check[]): FeatureMetrics[] {
  const by = new Map<string, Check[]>();
  for (const c of checks) by.set(c.feature, [...(by.get(c.feature) ?? []), c]);
  return [...by.entries()].map(([feature, cs]) => {
    let found = 0, missed = 0, falseAlarms = 0, wrongValues = 0, exact = 0;
    for (const c of cs) {
      const valueOk = same(c.expected, c.actual);
      if (!valueOk) wrongValues++;
      if (c.expectedProblem === true && c.actualProblem === true) found++;
      if (c.expectedProblem === true && c.actualProblem !== true) missed++;
      if (c.expectedProblem !== true && c.actualProblem === true) falseAlarms++;
      if (valueOk && c.expectedProblem === c.actualProblem) exact++;
    }
    const hasProblems = cs.some(c => c.expectedProblem !== null);
    return {
      feature, cases: cs.length, exact, found, missed, falseAlarms, wrongValues, exactMatchRate: exact / cs.length,
      precision: hasProblems && found + falseAlarms > 0 ? found / (found + falseAlarms) : null,
      recall: hasProblems && found + missed > 0 ? found / (found + missed) : null,
    };
  }).sort((a, b) => a.feature.localeCompare(b.feature));
}

export const failures = (checks: Check[], feature?: string) =>
  checks.filter(c => (!feature || c.feature === feature) && (!same(c.expected, c.actual) || c.expectedProblem !== c.actualProblem));
