import type { RoundingOption } from './constants.js';

export function toFils(qar: number): number {
  return Math.round(qar * 1000);
}

export function toQar(fils: number): number {
  return fils / 1000;
}

export function roundMoney(amount: number, rounding: RoundingOption = 'exact'): number {
  if (rounding === 'exact') {
    return Math.round(amount * 100) / 100;
  }
  const step = parseFloat(rounding);
  if (isNaN(step) || step <= 0) return Math.round(amount * 100) / 100;
  return Math.round(amount / step) * step;
}
