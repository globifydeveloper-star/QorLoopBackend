import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Email one-time codes and step-up windows (plan Part 5, ADR 021). These limits are constants on purpose: no
 * environment variable can weaken them in production.
 */
export const OTP = Object.freeze({
  /** A code is valid for 10 minutes from its send; a resend issues a new code and invalidates the previous one. */
  ttlMs: 10 * 60_000,
  /** Wrong codes per challenge; the next attempt locks the challenge (a new sign-in is needed). */
  maxAttempts: 5,
  /** Sends per challenge: the first one and two resends. */
  maxSends: 3,
  resendCooldownMs: 60_000,
  userSendsPerHour: 5,
  storeSendsPerHour: 30,
});
/** Step-up windows from the last fresh second factor inside a session (owner decision D13, as changed). */
export const STEP_UP = Object.freeze({ securityMs: 10 * 60_000, workMs: 30 * 60_000 });
export type StepUpWindow = 'security' | 'work' | 'single';
export const stepUpWindowMs = (window: StepUpWindow) => window === 'work' ? STEP_UP.workMs : STEP_UP.securityMs;
/** Session limits (owner decision 2): a 20-day hard limit from sign-in and 7 days idle; a shared computer gets 12 hours. */
export const SESSION_LIMITS = Object.freeze({ maxDays: 20, idleDays: 7, sharedHours: 12, deviceTrustDays: 90, touchEveryMs: 5 * 60_000 });

/** Six random digits, zero-padded. */
export const generateOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

const keys = new Map<string, Buffer>();
function otpKey(secret: string) {
  let key = keys.get(secret);
  if (!key) keys.set(secret, key = Buffer.from(hkdfSync('sha256', secret, 'qorloop-otp', 'email one-time code', 32)));
  return key;
}
/**
 * HMAC-SHA256 of the code bound to its challenge, keyed from AUTH_SECRET. A plain digest of a six-digit code would be
 * reversed from a database copy in milliseconds; this one needs the server secret.
 */
export const otpHash = (secret: string, challengeId: string, code: string) =>
  createHmac('sha256', otpKey(secret)).update(challengeId + ':' + code).digest('hex');
export function otpMatches(secret: string, challengeId: string, code: string, expectedHash: string | null) {
  if (!expectedHash || !/^\d{6}$/.test(code)) return false;
  const actual = Buffer.from(otpHash(secret, challengeId, code), 'hex'), expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** "o***@e***.test": enough to recognise the mailbox, never the full address. */
export function maskEmail(email: string) {
  const [local = '', domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain, tld = dot > 0 ? domain.slice(dot) : '';
  return (local[0] ?? '') + '***@' + (host[0] ?? '') + '***' + tld;
}

/** A short device label from the User-Agent header, e.g. "Chrome on Windows". Never stored raw. */
export function deviceLabel(userAgent: string | undefined) {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown system';
  return browser + ' on ' + os;
}
