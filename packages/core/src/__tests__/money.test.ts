import { describe, it, expect } from '@jest/globals';
import { toFils, toQar, roundMoney } from '../money.js';

describe('Money and Currency Handling (Fils & QAR)', () => {
  it('converts QAR to Fils correctly (1000 fils = 1 QAR)', () => {
    expect(toFils(1)).toBe(1000);
    expect(toFils(12.5)).toBe(12500);
    expect(toFils(0.25)).toBe(250);
  });

  it('converts Fils to QAR correctly', () => {
    expect(toQar(1000)).toBe(1);
    expect(toQar(12500)).toBe(12.5);
    expect(toQar(250)).toBe(0.25);
  });

  it('rounds money accurately by exact 2 decimal places', () => {
    expect(roundMoney(10.126, 'exact')).toBe(10.13);
    expect(roundMoney(10.124, 'exact')).toBe(10.12);
  });

  it('rounds money to nearest 0.05 step', () => {
    expect(roundMoney(10.12, '0.05')).toBe(10.1);
    expect(roundMoney(10.14, '0.05')).toBe(10.15);
  });

  it('rounds money to nearest 0.25 step', () => {
    expect(roundMoney(10.12, '0.25')).toBe(10.0);
    expect(roundMoney(10.18, '0.25')).toBe(10.25);
    expect(roundMoney(10.65, '0.25')).toBe(10.75);
  });

  it('rounds money to nearest 0.50 step', () => {
    expect(roundMoney(10.20, '0.50')).toBe(10.0);
    expect(roundMoney(10.35, '0.50')).toBe(10.5);
  });
});


describe('integer-fils pricing (no float noise)', () => {
  it('5.5 +15% is 6.33, not 6.3249999', async () => {
    const { priceFromRule } = await import('../pricing.js');
    expect(priceFromRule(5.5, { mode: 'percent', value: 15 }, 'exact')).toBe(6.33);
  });
  it('half-up on exact halves', async () => {
    const { roundMoney } = await import('../money.js');
    expect(roundMoney(1.005, 'exact')).toBe(1.01);
  });
});
