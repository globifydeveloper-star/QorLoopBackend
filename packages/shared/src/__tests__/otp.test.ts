import { describe, expect, it } from '@jest/globals';
import { deviceLabel, generateOtp, maskEmail, OTP, otpHash, otpMatches, STEP_UP, stepUpWindowMs } from '../otp.js';

const secret = 'test-only-secret-at-least-thirty-two-characters';

describe('email one-time codes', () => {
  it('generates six zero-padded digits', () => {
    const codes = Array.from({ length: 500 }, generateOtp);
    expect(codes.every(c => /^\d{6}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(450);
  });
  it('binds the hash to the challenge and the server secret, and never stores the code', () => {
    const hash = otpHash(secret, 'challenge-a', '012345');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('012345');
    expect(otpHash(secret, 'challenge-b', '012345')).not.toBe(hash);
    expect(otpHash(secret + 'x', 'challenge-a', '012345')).not.toBe(hash);
    expect(otpMatches(secret, 'challenge-a', '012345', hash)).toBe(true);
    for (const code of ['012346', '12345', '0123456', ' 012345', '']) expect(otpMatches(secret, 'challenge-a', code, hash)).toBe(false);
    expect(otpMatches(secret, 'challenge-a', '012345', null)).toBe(false);
    expect(otpMatches(secret, 'challenge-a', '012345', 'abc')).toBe(false);
  });
  it('keeps the owner-approved limits', () => {
    expect(OTP).toEqual({ ttlMs: 600_000, maxAttempts: 5, maxSends: 3, resendCooldownMs: 60_000, userSendsPerHour: 5, storeSendsPerHour: 30 });
    expect(STEP_UP).toEqual({ securityMs: 600_000, workMs: 1_800_000 });
    expect([stepUpWindowMs('security'), stepUpWindowMs('single'), stepUpWindowMs('work')]).toEqual([600_000, 600_000, 1_800_000]);
    expect(Object.isFrozen(OTP)).toBe(true);
  });
  it('masks email addresses and labels devices without the raw user agent', () => {
    expect(maskEmail('owner@example.test')).toBe('o***@e***.test');
    expect(maskEmail('a@b')).toBe('a***@b***');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome on Windows');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1')).toBe('Safari on iOS');
    expect(deviceLabel(undefined)).toBe('Browser on unknown system');
  });
});
