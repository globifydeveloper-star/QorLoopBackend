import type { RoundingOption } from '@qorloop/shared';

/** All money maths runs in integer fils (QAR x 1000) so 5.5 x 1.15 never becomes 6.3249999. */
export function toFils(qar: number): number {
  return Math.round(qar * 1000);
}

export function fromFils(fils: number): number {
  return fils / 1000;
}

/** Round a (possibly fractional) fils amount to the tenant rounding step. 'exact' = nearest 0.01 QAR. */
export function roundFils(fils: number, rounding: RoundingOption = 'exact'): number {
  const clean = Math.round(fils * 1e6) / 1e6; // strip float noise before rounding half-up
  const stepFils = rounding === 'exact' ? 10 : Math.round(parseFloat(rounding) * 1000);
  if (!Number.isFinite(stepFils) || stepFils <= 0) return Math.round(clean / 10) * 10;
  return Math.round(clean / stepFils) * stepFils;
}

export function round2(qar: number): number {
  return fromFils(roundFils(toFils(qar), 'exact'));
}
