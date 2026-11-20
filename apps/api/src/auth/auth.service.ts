import { Inject, Injectable, Optional, BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import { z } from 'zod';
import { Database, type TenantData, type Role } from '../../../../packages/db/src/database.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import * as contracts from '../../../../packages/shared/src/contracts.js';
import { digest, opaqueToken, hashPassword, verifyPassword, matchesDigest, seal, unseal } from '../../../../packages/shared/src/security.js';
import { deviceLabel, generateOtp, maskEmail, OTP, otpHash, otpMatches, SESSION_LIMITS, STEP_UP, stepUpWindowMs, type StepUpWindow } from '../../../../packages/shared/src/otp.js';
import type { MailTrigger } from '../../../../packages/shared/src/mail.js';
import { hasPermission, type Permission } from '../../../../packages/core/src/roles.js';
import type { MarketplaceId } from '../../../../packages/core/src/constants.js';
import { CONFIG, MAIL_TRIGGER } from '../tokens.js';

export interface RequestContext {
  tenantId: string;
  requestId: string;
  token?: string;
  csrf?: string;
  /** The trusted-device cookie (ADR 021). */
  deviceToken?: string;
  /** The sign-in challenge cookie, between the password and the code. */
  challengeToken?: string;
  userAgent?: string;
}
export type Principal = Awaited<ReturnType<AuthService['checkSession']>>;
export type MailMessage = { to: string; subject: string; text: string };
export type SessionState = 'authenticated' | 'authenticator_setup_required';
/** A new session, and the device cookie to set when this browser became (or stays) trusted. */
export type SessionIssue = {
  kind: 'session'; token: string; csrfToken: string; expiresAt: Date; state: SessionState;
  device: { token: string; expiresAt: Date } | null; recoveryCodes?: string[];
};
/** Password accepted on an unknown device: the second factor is next. */
export type ChallengeIssue = {
  kind: 'challenge'; challengeToken: string; state: 'otp_required' | 'totp_required'; challengeExpiresAt: Date;
  resendAvailableAt: Date | null; maskedEmail: string | null;
};
type Code = 'CHALLENGE_EXPIRED' | 'OTP_INVALID' | 'OTP_LOCKED' | 'OTP_SEND_LIMIT' | 'STEP_UP_REQUIRED' | 'AUTHENTICATOR_SETUP_REQUIRED';
const fail = (status: number, code: Code, message: string, meta?: Record<string, unknown>) => new HttpException({ code, message, ...(meta ? { meta } : {}) }, status);
const DAY = 86_400_000;
type CheckOutcome = { ok: true } | { ok: false; attemptsLeft: number };

@Injectable()
export class AuthService {
  private readonly dummyHash = hashPassword(opaqueToken());
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CONFIG) private readonly config: Config,
    @Optional() @Inject(MAIL_TRIGGER) private readonly mailTrigger?: MailTrigger,
  ) {}

  // ───────────── sessions ─────────────

  private needsAuthenticator(tenant: { settings: { mfaRequiredForAll: boolean } | null }, user: { mfaSecret: string | null }) {
    return Boolean(tenant.settings?.mfaRequiredForAll) && !user.mfaSecret;
  }
  /** A session bound to `deviceId` (null: shared computer, 12 hours), 20 days from now at most. */
  /** `freshFactor`: the second factor was checked just now (a sign-in with a code), which counts as a step-up. */
  private async issue(data: TenantData, user: { id: string; mfaSecret: string | null }, deviceId: string | null, ctx: RequestContext,
    device: SessionIssue['device'] = null, freshFactor = false): Promise<SessionIssue> {
    const token = opaqueToken(), csrfToken = opaqueToken();
    const expiresAt = new Date(Date.now() + (deviceId ? this.config.SESSION_MAX_DAYS * DAY : SESSION_LIMITS.sharedHours * 3_600_000));
    await data.createSession({ userId: user.id, tokenHash: digest(token), csrfHash: digest(csrfToken), assurance: 'full', expiresAt, deviceId,
      userAgent: deviceLabel(ctx.userAgent), stepUpAt: freshFactor ? new Date() : null });
    return { kind: 'session', token, csrfToken, expiresAt, state: this.needsAuthenticator(await data.tenant(), user) ? 'authenticator_setup_required' : 'authenticated', device };
  }
  /** This browser's trusted device for the user, or null (unknown, another user's, or expired). */
  private async knownDevice(data: TenantData, ctx: RequestContext, userId: string) {
    if (!ctx.deviceToken) return null;
    const device = await data.deviceByHash(digest(ctx.deviceToken));
    return device && device.userId === userId && device.expiresAt > new Date() ? device : null;
  }
  private async trustDevice(data: TenantData, userId: string, ctx: RequestContext, requestId: string) {
    const token = opaqueToken(), expiresAt = new Date(Date.now() + SESSION_LIMITS.deviceTrustDays * DAY);
    const device = await data.createDevice({ userId, tokenHash: digest(token), label: deviceLabel(ctx.userAgent), expiresAt });
    await data.event('auth.new_device', userId, device.id, requestId, { label: device.label ?? 'Browser' });
    return { id: device.id, cookie: { token, expiresAt } };
  }
  private idleExpiry(session: { expiresAt: Date; lastSeenAt: Date }) {
    return new Date(Math.min(session.expiresAt.getTime(), session.lastSeenAt.getTime() + this.config.SESSION_IDLE_DAYS * DAY));
  }
  private stepUpView(stepUpAt: Date | null) {
    const until = (ms: number) => stepUpAt && stepUpAt.getTime() + ms > Date.now() ? new Date(stepUpAt.getTime() + ms) : null;
    return { securityValidUntil: until(STEP_UP.securityMs), workValidUntil: until(STEP_UP.workMs) };
  }

  /**
   * Every authenticated request: the 20-day hard limit, 7 days idle, the device binding (a session cookie without its
   * device cookie is refused), an active membership, CSRF on mutations, the store's authenticator policy, the
   * permission and, for sensitive actions, a fresh step-up. `stepUp: 'single'` also consumes the step-up.
   */
  async checkSession(data: TenantData, ctx: RequestContext, options: { partial?: boolean; mutation?: boolean; permission?: Permission; touch?: boolean; stepUp?: StepUpWindow } = {}) {
    const session = ctx.token ? await data.sessionByHash(digest(ctx.token)) : null;
    if (!session) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Sign in to continue' });
    const now = Date.now();
    if (session.expiresAt.getTime() <= now || this.idleExpiry(session).getTime() <= now)
      throw new UnauthorizedException({ code: 'SESSION_EXPIRED', message: 'Your session expired; sign in again' });
    if (session.deviceId && (!session.device || !ctx.deviceToken || !matchesDigest(ctx.deviceToken, session.device.tokenHash) || session.device.expiresAt.getTime() <= now))
      throw new UnauthorizedException({ code: 'SESSION_EXPIRED', message: 'Sign in again on this device' });
    const member = await data.membership(session.userId);
    if (!member?.active) throw new UnauthorizedException('Session expired or invalid');
    if (options.mutation && (!ctx.csrf || !matchesDigest(ctx.csrf, session.csrfHash))) throw new ForbiddenException({ code: 'CSRF_REQUIRED', message: 'CSRF token required' });
    const tenant = await data.tenant();
    if (!options.partial && this.needsAuthenticator(tenant, session.user)) {
      throw fail(403, 'AUTHENTICATOR_SETUP_REQUIRED', 'This store requires an authenticator app; set it up to continue');
    }
    if (options.permission && !hasPermission(member.role, options.permission, tenant.settings?.analystCanExport ?? true)) {
      throw new ForbiddenException('Permission denied');
    }
    if (options.stepUp) {
      if (!session.stepUpAt || session.stepUpAt.getTime() + stepUpWindowMs(options.stepUp) <= now) {
        throw fail(403, 'STEP_UP_REQUIRED', 'Confirm it is you with a fresh code', { window: options.stepUp === 'work' ? 'work' : 'security' });
      }
      if (options.stepUp === 'single') await data.setStepUp(session.id, null);
    }
    if (options.touch !== false && now - session.lastSeenAt.getTime() >= SESSION_LIMITS.touchEveryMs) await data.touchSession(session.id);
    return { session, user: session.user, member, tenant };
  }
  /** `timeout` (ms) only for the few bulk requests that must stay one transaction (adopting prices); others keep Database.run's 20 s. */
  authenticated<T>(ctx: RequestContext, options: { partial?: boolean; mutation?: boolean; permission?: Permission; timeout?: number; stepUp?: StepUpWindow }, action: (data: TenantData, principal: Principal) => Promise<T>) {
    return this.db.run(ctx.tenantId, async data => action(data, await this.checkSession(data, ctx, options)), { timeout: options.timeout });
  }
  private publicUser(user: { id: string; email: string; name: string }) { return { id: user.id, email: user.email, name: user.name }; }
  private nudgeMail() { void this.mailTrigger?.nudge().catch(() => undefined); }

  // ───────────── one-time codes ─────────────

  /** Why another code email may not be sent now, or null: per challenge, cooldown, per user and per store per hour. */
  private async sendRefusal(data: TenantData, userId: string, challenge: { sends: number; lastSentAt: Date | null } | null) {
    const now = Date.now();
    if (challenge && challenge.sends >= OTP.maxSends) return { retryAfterSeconds: null };
    if (challenge?.lastSentAt && challenge.lastSentAt.getTime() + OTP.resendCooldownMs > now) {
      return { retryAfterSeconds: Math.ceil((challenge.lastSentAt.getTime() + OTP.resendCooldownMs - now) / 1000) };
    }
    const hourAgo = new Date(now - 3_600_000);
    if (await data.codeSendsSince(hourAgo, userId) >= OTP.userSendsPerHour || await data.codeSendsSince(hourAgo) >= OTP.storeSendsPerHour) return { retryAfterSeconds: 3600 };
    return null;
  }
  /** A new code for the challenge: it replaces the previous code, restarts the 10 minutes and is mailed first. */
  private async sendCode(data: TenantData, challenge: { id: string; sends: number; purpose: string }, user: { id: string; email: string }, requestId: string) {
    const code = generateOtp(), now = new Date(), expiresAt = new Date(now.getTime() + OTP.ttlMs), sendNo = challenge.sends + 1;
    await data.updateChallenge(challenge.id, { codeHash: otpHash(this.config.AUTH_SECRET, challenge.id, code), sends: sendNo, lastSentAt: now, expiresAt });
    const subject = challenge.purpose === 'login' ? 'Your Qorloop sign-in code' : 'Your Qorloop confirmation code';
    await this.mail(data, 'otp:' + challenge.id + ':' + sendNo, {
      to: user.email, subject,
      text: `Your code is ${code}. It expires in 10 minutes and works once.\n\nIf you did not ask for it, someone may know your password: change it, or tell your store Owner. Qorloop never asks for this code by phone or chat.`,
    }, { priority: 1, discardAfter: expiresAt });
    await data.event('auth.otp_sent', user.id, challenge.id, requestId, { purpose: challenge.purpose, sendNo });
    return { expiresAt, resendAvailableAt: sendNo < OTP.maxSends ? new Date(now.getTime() + OTP.resendCooldownMs) : null };
  }
  private async totpMatches(data: TenantData, user: { id: string; mfaSecret: string | null; lastTotpStep: number | null }, code: string) {
    if (!user.mfaSecret) return false;
    const secret = await unseal<string>(user.mfaSecret, this.config.AUTH_SECRET);
    const result = await verifyTotp({ secret, token: code, epochTolerance: 30, ...(user.lastTotpStep == null ? {} : { afterTimeStep: user.lastTotpStep }) });
    if (!result.valid || !('timeStep' in result)) return false;
    await data.updateUser(user.id, { lastTotpStep: result.timeStep });
    return true;
  }
  /**
   * Checks one answer to a challenge: the emailed code, the app's code or a recovery code. A wrong answer counts an
   * attempt (written: the caller returns, never throws, inside the transaction); the fifth wrong answer locks it.
   */
  private async check(data: TenantData, challenge: { id: string; method: string; attempts: number; purpose: string; codeHash: string | null },
    user: { id: string; mfaSecret: string | null; lastTotpStep: number | null }, answer: { code?: string; recoveryCode?: string }, requestId: string): Promise<CheckOutcome> {
    const ok = answer.recoveryCode
      ? challenge.method === 'totp' && (await data.consumeRecovery(user.id, digest(answer.recoveryCode))).count > 0
      : challenge.method === 'email' ? otpMatches(this.config.AUTH_SECRET, challenge.id, answer.code ?? '', challenge.codeHash)
        : await this.totpMatches(data, user, answer.code ?? '');
    if (ok) {
      await data.updateChallenge(challenge.id, { consumedAt: new Date() });
      if (answer.recoveryCode) await data.event('auth.recovery_used', user.id, user.id, requestId);
      await data.event('auth.otp_verified', user.id, challenge.id, requestId, { purpose: challenge.purpose, method: answer.recoveryCode ? 'recovery_code' : challenge.method });
      return { ok: true };
    }
    const attempts = challenge.attempts + 1, attemptsLeft = Math.max(0, OTP.maxAttempts - attempts);
    await data.updateChallenge(challenge.id, { attempts, ...(attemptsLeft === 0 ? { consumedAt: new Date() } : {}) });
    await data.event('auth.otp_failed', user.id, challenge.id, requestId, { purpose: challenge.purpose, attemptsLeft });
    if (attemptsLeft === 0) await data.event('auth.otp_locked', user.id, challenge.id, requestId, { purpose: challenge.purpose });
    return { ok: false, attemptsLeft };
  }
  private wrongAnswer(outcome: { attemptsLeft: number }) {
    return outcome.attemptsLeft === 0
      ? fail(401, 'OTP_LOCKED', 'Too many wrong codes; sign in again', { attemptsLeft: 0 })
      : fail(401, 'OTP_INVALID', 'That code is not right', { attemptsLeft: outcome.attemptsLeft });
  }
  private challengeView(challengeToken: string, method: string, user: { email: string }, sent: { expiresAt: Date; resendAvailableAt: Date | null } | null, expiresAt: Date): ChallengeIssue {
    return {
      kind: 'challenge', challengeToken, state: method === 'totp' ? 'totp_required' : 'otp_required',
      challengeExpiresAt: sent?.expiresAt ?? expiresAt, resendAvailableAt: sent?.resendAvailableAt ?? null, maskedEmail: method === 'email' ? maskEmail(user.email) : null,
    };
  }

  // ───────────── sign-in ─────────────

  /**
   * Password first (unchanged generic 401). On this user's trusted device a session follows at once. Otherwise a
   * challenge: the authenticator app when the user has one (the email code is not offered instead), else an emailed code.
   */
  async login(ctx: RequestContext, input: z.infer<typeof contracts.login>): Promise<SessionIssue | ChallengeIssue> {
    const result = await this.db.run(ctx.tenantId, async data => {
      const user = await data.userByEmail(input.email);
      const valid = await verifyPassword(input.password, user?.passwordHash ?? await this.dummyHash);
      const member = user ? await data.membership(user.id) : null;
      if (!valid || !user || !member?.active) {
        await data.event('auth.login_failed', null, null, ctx.requestId);
        return null;
      }
      await data.event('auth.password_verified', user.id, user.id, ctx.requestId);
      const device = input.sharedDevice ? null : await this.knownDevice(data, ctx, user.id);
      if (device) {
        await data.touchDevice(device.id);
        await data.event('auth.login_succeeded', user.id, user.id, ctx.requestId, { newDevice: false });
        return this.issue(data, user, device.id, ctx);
      }
      const method = user.mfaSecret ? 'totp' : 'email';
      if (method === 'email') {
        const refusal = await this.sendRefusal(data, user.id, null);
        if (refusal) {
          await data.event('auth.otp_send_limited', user.id, user.id, ctx.requestId, { purpose: 'login' });
          return { kind: 'limited' as const, ...refusal };
        }
      }
      await data.closeChallenges(user.id, 'login');
      const challengeToken = opaqueToken(), expiresAt = new Date(Date.now() + OTP.ttlMs);
      const challenge = await data.createChallenge({ userId: user.id, purpose: 'login', method, challengeHash: digest(challengeToken), trustDevice: !input.sharedDevice, expiresAt });
      const sent = method === 'email' ? await this.sendCode(data, challenge, user, ctx.requestId) : null;
      return this.challengeView(challengeToken, method, user, sent, expiresAt);
    });
    if (!result) throw new UnauthorizedException('Invalid email or password');
    if (result.kind === 'limited') throw fail(429, 'OTP_SEND_LIMIT', 'Too many codes were sent; try again later', { retryAfterSeconds: result.retryAfterSeconds });
    if (result.kind === 'challenge' && result.state === 'otp_required') this.nudgeMail();
    return result;
  }
  private async openLoginChallenge(data: TenantData, ctx: RequestContext) {
    const challenge = ctx.challengeToken ? await data.challengeByHash(digest(ctx.challengeToken)) : null;
    if (!challenge || challenge.purpose !== 'login' || challenge.consumedAt || challenge.expiresAt <= new Date()) return null;
    return (await data.membership(challenge.userId))?.active ? challenge : null;
  }
  /** The second factor on a new device: a session, and this browser trusted for 90 days unless it is a shared computer. */
  async verifyLogin(ctx: RequestContext, answer: { code?: string; recoveryCode?: string }) {
    const result = await this.db.run(ctx.tenantId, async data => {
      const challenge = await this.openLoginChallenge(data, ctx);
      if (!challenge) return { kind: 'expired' as const };
      if (answer.recoveryCode && challenge.method !== 'totp') return { kind: 'expired' as const };
      const outcome = await this.check(data, challenge, challenge.user, answer, ctx.requestId);
      if (!outcome.ok) return { kind: 'wrong' as const, ...outcome };
      let deviceId: string | null = null, cookie: SessionIssue['device'] = null;
      if (challenge.trustDevice) {
        const known = await this.knownDevice(data, ctx, challenge.userId);
        if (known) deviceId = known.id;
        else ({ id: deviceId, cookie } = await this.trustDevice(data, challenge.userId, ctx, ctx.requestId));
      }
      await data.event('auth.login_succeeded', challenge.userId, challenge.userId, ctx.requestId, { newDevice: cookie !== null });
      return this.issue(data, challenge.user, deviceId, ctx, cookie, true);
    });
    if (result.kind === 'expired') throw fail(401, 'CHALLENGE_EXPIRED', 'This sign-in expired; enter your password again');
    if (result.kind === 'wrong') throw this.wrongAnswer(result);
    return result;
  }
  /** A new emailed code for the pending sign-in (the previous code stops working). */
  async resendLogin(ctx: RequestContext) {
    const result = await this.db.run(ctx.tenantId, async data => {
      const challenge = await this.openLoginChallenge(data, ctx);
      if (!challenge || challenge.method !== 'email') return { kind: 'expired' as const };
      const refusal = await this.sendRefusal(data, challenge.userId, challenge);
      if (refusal) {
        await data.event('auth.otp_send_limited', challenge.userId, challenge.id, ctx.requestId, { purpose: 'login' });
        return { kind: 'limited' as const, ...refusal };
      }
      const sent = await this.sendCode(data, challenge, challenge.user, ctx.requestId);
      return { kind: 'sent' as const, challengeExpiresAt: sent.expiresAt, resendAvailableAt: sent.resendAvailableAt };
    });
    if (result.kind === 'expired') throw fail(401, 'CHALLENGE_EXPIRED', 'This sign-in expired; enter your password again');
    if (result.kind === 'limited') throw fail(429, 'OTP_SEND_LIMIT', 'No more codes can be sent now', { retryAfterSeconds: result.retryAfterSeconds });
    this.nudgeMail();
    return { challengeExpiresAt: result.challengeExpiresAt, resendAvailableAt: result.resendAvailableAt };
  }

  /** Accepting an invitation proves the mailbox: the browser becomes trusted and a session starts. */
  async accept(ctx: RequestContext, input: z.infer<typeof contracts.acceptInvitation>) {
    const passwordHash = await hashPassword(input.password);
    return this.db.run(ctx.tenantId, async data => {
      const invite = await data.invitationByHash(digest(input.token));
      if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= new Date()) throw new BadRequestException('Invitation expired or invalid');
      let user = await data.userByEmail(invite.email);
      let member = user ? await data.membership(user.id) : null;
      if (member?.active) throw new ConflictException('Already a team member');
      if (user) {
        await data.updateUser(user.id, { passwordHash, name: input.name });
        await data.signOutUserExcept(user.id, null);
        await data.invalidateResets(user.id);
      } else {
        user = await data.createUser({ email: invite.email, name: input.name, passwordHash, emailVerifiedAt: new Date() });
      }
      if (member) await data.updateMembership(member.id, { active: true, role: invite.role });
      else member = await data.createMembership(user.id, invite.role);
      await data.updateInvitation(invite.id, { acceptedAt: new Date(), pendingEmail: null });
      await data.event('invitation.accepted', user.id, invite.id, ctx.requestId, { role: invite.role });
      const { id, cookie } = await this.trustDevice(data, user.id, ctx, ctx.requestId);
      return this.issue(data, user, id, ctx, cookie);
    });
  }
  async me(ctx: RequestContext) {
    return this.authenticated(ctx, {}, async (_data, p) => ({
      user: this.publicUser(p.user), role: p.member.role,
      permissions: (await import('../../../../packages/core/src/roles.js')).ROLE_PERMISSIONS[p.member.role]
        .filter(permission => hasPermission(p.member.role, permission, p.tenant.settings?.analystCanExport ?? true)),
      tenant: { id: p.tenant.id, name: p.tenant.name, slug: p.tenant.slug },
      mfaEnabled: Boolean(p.user.mfaSecret), expiresAt: p.session.expiresAt, ...this.stepUpView(p.session.stepUpAt),
    }));
  }
  /** Public only at the guard layer so missing/expired cookies can receive a precise 401. No session touch. */
  async sessionStatus(ctx: RequestContext) {
    return this.db.readSnapshot(ctx.tenantId, async data => {
      const p = await this.checkSession(data, ctx, { partial: true, touch: false });
      const state: SessionState = this.needsAuthenticator(p.tenant, p.user) ? 'authenticator_setup_required' : 'authenticated';
      return {
        state, expiresAt: p.session.expiresAt, idleExpiresAt: this.idleExpiry(p.session),
        nextAction: state === 'authenticated' ? 'none' : 'setup_authenticator', ...this.stepUpView(p.session.stepUpAt),
      };
    });
  }
  /** Ends this session; the device stays trusted (signing in again on it needs only the password). */
  async logout(ctx: RequestContext) {
    return this.authenticated(ctx, { partial: true, mutation: true }, async (data, p) => {
      await data.deleteSession(p.session.id);
      await data.event('auth.logout', p.user.id, p.session.id, ctx.requestId);
      return { success: true };
    });
  }

  // ───────────── step-up (a fresh code inside a session) ─────────────

  async startStepUp(ctx: RequestContext) {
    const result = await this.authenticated(ctx, { mutation: true }, async (data, p) => {
      const method = p.user.mfaSecret ? 'totp' : 'email';
      if (method === 'email') {
        const open = await data.openStepUp(p.session.id);
        const refusal = await this.sendRefusal(data, p.user.id, open && open.expiresAt > new Date() ? open : null);
        if (refusal) {
          await data.event('auth.otp_send_limited', p.user.id, p.session.id, ctx.requestId, { purpose: 'step_up' });
          return { kind: 'limited' as const, ...refusal };
        }
      }
      await data.closeChallenges(p.user.id, 'step_up', p.session.id);
      const expiresAt = new Date(Date.now() + OTP.ttlMs);
      const challenge = await data.createChallenge({ userId: p.user.id, purpose: 'step_up', method, challengeHash: digest(opaqueToken()), sessionId: p.session.id, expiresAt });
      const sent = method === 'email' ? await this.sendCode(data, challenge, p.user, ctx.requestId) : null;
      return { kind: 'started' as const, method, expiresAt: sent?.expiresAt ?? expiresAt, resendAvailableAt: sent?.resendAvailableAt ?? null, maskedEmail: method === 'email' ? maskEmail(p.user.email) : null };
    });
    if (result.kind === 'limited') throw fail(429, 'OTP_SEND_LIMIT', 'Too many codes were sent; try again later', { retryAfterSeconds: result.retryAfterSeconds });
    if (result.method === 'email') this.nudgeMail();
    const { kind: _kind, ...view } = result;
    return view;
  }
  async verifyStepUp(ctx: RequestContext, answer: { code?: string; recoveryCode?: string }) {
    const result = await this.authenticated(ctx, { mutation: true }, async (data, p) => {
      const challenge = await data.openStepUp(p.session.id);
      if (!challenge || challenge.expiresAt <= new Date() || (answer.recoveryCode && challenge.method !== 'totp')) return { kind: 'expired' as const };
      const outcome = await this.check(data, challenge, p.user, answer, ctx.requestId);
      if (!outcome.ok) return { kind: 'wrong' as const, ...outcome };
      const now = new Date();
      await data.setStepUp(p.session.id, now);
      await data.event('auth.step_up_verified', p.user.id, p.session.id, ctx.requestId, { method: answer.recoveryCode ? 'recovery_code' : challenge.method });
      return { kind: 'ok' as const, ...this.stepUpView(now) };
    });
    if (result.kind === 'expired') throw fail(401, 'CHALLENGE_EXPIRED', 'Ask for a new code');
    if (result.kind === 'wrong') throw this.wrongAnswer(result);
    const { kind: _kind, ...view } = result;
    return view;
  }

  // ───────────── password, mail ─────────────

  private linkOrigin(hostname: string) {
    // Origin comes only from configuration and the stored, operations-controlled host.
    return this.config.NODE_ENV === 'production' ? 'https://' + hostname : this.config.APP_ORIGIN.replace(new URL(this.config.APP_ORIGIN).hostname, hostname);
  }
  private async mail(data: TenantData, key: string, message: MailMessage, options: { priority?: number; discardAfter?: Date } = {}) {
    await data.queueMail(key, await seal(message, this.config.AUTH_SECRET), options);
  }
  private async invitationEmail(data: TenantData, invitation: {id: string; email: string}, token: string) {
    const tenant = await data.tenant();
    await this.mail(data, 'invitation:' + invitation.id + ':' + digest(token), {
      to: invitation.email, subject: 'Your Qorloop invitation',
      text: 'Accept your invitation (expires in 48 hours): ' + this.linkOrigin(tenant.hostname) + '/invitations/accept#token=' + token,
    });
  }
  async forgot(ctx: RequestContext, email: string) {
    await this.db.run(ctx.tenantId, async data => {
      const user = await data.userByEmail(email);
      // Equalize the expensive portion for known and unknown addresses.
      await verifyPassword(opaqueToken(), user?.passwordHash ?? await this.dummyHash);
      if (!user || !(await data.membership(user.id))?.active) return;
      await data.invalidateResets(user.id);
      const token = opaqueToken();
      const reset = await data.createReset({ userId: user.id, tokenHash: digest(token), expiresAt: new Date(Date.now() + 30 * 60_000) });
      const tenant = await data.tenant();
      await this.mail(data, 'reset:' + reset.id, {
        to: email, subject: 'Reset your Qorloop password',
        text: 'Reset your password (expires in 30 minutes): ' + this.linkOrigin(tenant.hostname) + '/password/reset#token=' + token,
      });
      await data.event('auth.password_reset_requested', user.id, reset.id, ctx.requestId);
    });
    return { success: true };
  }
  /** Signs the user out everywhere, trusted devices included; the authenticator app stays enrolled. */
  async reset(ctx: RequestContext, input: z.infer<typeof contracts.resetPassword>) {
    const passwordHash = await hashPassword(input.password);
    return this.db.run(ctx.tenantId, async data => {
      const reset = await data.resetByHash(digest(input.token));
      if (!reset || reset.usedAt || reset.expiresAt <= new Date()) throw new BadRequestException('Reset token expired or invalid');
      if (!(await data.membership(reset.userId))?.active) throw new BadRequestException('Reset token expired or invalid');
      await data.updateUser(reset.userId, { passwordHash });
      await data.invalidateResets(reset.userId);
      const count = await data.signOutUserExcept(reset.userId, null);
      await data.event('auth.password_reset', reset.userId, reset.id, ctx.requestId);
      await data.event('auth.sessions_revoked_all', reset.userId, reset.userId, ctx.requestId, { count, reason: 'password_reset' });
      return { success: true };
    });
  }
  /** Security step-up. Every other session and device of the user is signed out; this one stays. */
  async changePassword(ctx: RequestContext, input: z.infer<typeof contracts.changePassword>) {
    const passwordHash = await hashPassword(input.newPassword);
    const result = await this.authenticated(ctx, { mutation: true, stepUp: 'security' }, async (data, p) => {
      if (!await verifyPassword(input.currentPassword, p.user.passwordHash)) return null;
      await data.updateUser(p.user.id, { passwordHash });
      await data.invalidateResets(p.user.id);
      const count = await data.signOutUserExcept(p.user.id, p.session.id);
      await data.event('auth.password_changed', p.user.id, p.user.id, ctx.requestId);
      await data.event('auth.sessions_revoked_all', p.user.id, p.user.id, ctx.requestId, { count, reason: 'password_changed' });
      return { success: true, signedOut: count };
    });
    if (!result) throw new BadRequestException({ message: 'Validation failed', details: [{ path: 'currentPassword', message: 'Your current password is not right' }] });
    return result;
  }
  /**
   * Single-use step-up. A link goes to the new address (24 hours); the old address is told. The address changes only
   * when the link is opened (confirmEmailChange), which signs the user out everywhere.
   */
  async requestEmailChange(ctx: RequestContext, newEmail: string) {
    return this.authenticated(ctx, { mutation: true, stepUp: 'single' }, async (data, p) => {
      if (newEmail === p.user.email) throw new BadRequestException({ message: 'Validation failed', details: [{ path: 'newEmail', message: 'This is already your address' }] });
      if (await data.userByEmail(newEmail)) throw new ConflictException('Another account of this store uses this address');
      await data.closeChallenges(p.user.id, 'email_change');
      const token = opaqueToken(), expiresAt = new Date(Date.now() + DAY);
      const challenge = await data.createChallenge({ userId: p.user.id, purpose: 'email_change', method: 'link', challengeHash: digest(token), pendingEmail: newEmail, expiresAt });
      const tenant = await data.tenant();
      await this.mail(data, 'email-change:' + challenge.id, {
        to: newEmail, subject: 'Confirm your new Qorloop email address',
        text: 'Confirm this address for your Qorloop account (expires in 24 hours): ' + this.linkOrigin(tenant.hostname) + '/account/email/confirm#token=' + token,
      });
      await this.mail(data, 'email-change-notice:' + challenge.id, {
        to: p.user.email, subject: 'Your Qorloop email address is being changed',
        text: `A change of your Qorloop sign-in address to ${maskEmail(newEmail)} was requested. If this was not you, sign in and change your password, or tell your store Owner.`,
      });
      await data.event('auth.email_change_requested', p.user.id, challenge.id, ctx.requestId);
      return { pendingEmail: maskEmail(newEmail), expiresAt };
    });
  }
  async confirmEmailChange(ctx: RequestContext, token: string) {
    return this.db.run(ctx.tenantId, async data => {
      const challenge = await data.challengeByHash(digest(token));
      if (!challenge || challenge.purpose !== 'email_change' || challenge.consumedAt || challenge.expiresAt <= new Date() || !challenge.pendingEmail
        || !(await data.membership(challenge.userId))?.active) throw new BadRequestException('Link expired or invalid');
      if (await data.userByEmail(challenge.pendingEmail)) throw new ConflictException('Another account of this store uses this address');
      const oldEmail = challenge.user.email;
      await data.updateUser(challenge.userId, { email: challenge.pendingEmail });
      await data.updateChallenge(challenge.id, { consumedAt: new Date() });
      await data.invalidateResets(challenge.userId);
      const count = await data.signOutUserExcept(challenge.userId, null);
      await this.mail(data, 'email-changed-notice:' + challenge.id, {
        to: oldEmail, subject: 'Your Qorloop email address was changed',
        text: `Your Qorloop sign-in address is now ${maskEmail(challenge.pendingEmail)}. If this was not you, tell your store Owner at once.`,
      });
      await data.event('auth.email_changed', challenge.userId, challenge.userId, ctx.requestId);
      await data.event('auth.sessions_revoked_all', challenge.userId, challenge.userId, ctx.requestId, { count, reason: 'email_changed' });
      return { success: true };
    });
  }

  // ───────────── authenticator app (optional, the stronger factor) ─────────────

  async setupAuthenticator(ctx: RequestContext, password: string) {
    return this.authenticated(ctx, { partial: true, mutation: true }, async (data, p) => {
      if (p.user.mfaSecret) throw new ConflictException('An authenticator app is already set up');
      if (!await verifyPassword(password, p.user.passwordHash)) throw new UnauthorizedException('Invalid credentials');
      const secret = generateSecret();
      await data.updateUser(p.user.id, { pendingMfaSecret: await seal(secret, this.config.AUTH_SECRET), pendingMfaExpiresAt: new Date(Date.now() + 600_000) });
      await data.event('auth.mfa_setup_started', p.user.id, p.user.id, ctx.requestId);
      return { totpUri: generateURI({ issuer: 'Qorloop', label: p.tenant.slug + ':' + p.user.email, secret }), expiresIn: 600 };
    });
  }
  /** Enrols the app (ten recovery codes, shown once). Other devices are signed out: from now on they need the app. */
  async confirmAuthenticator(ctx: RequestContext, code: string) {
    const result = await this.authenticated(ctx, { partial: true, mutation: true }, async (data, p) => {
      if (p.user.mfaSecret) throw new ConflictException('An authenticator app is already set up');
      if (!p.user.pendingMfaSecret || !p.user.pendingMfaExpiresAt || p.user.pendingMfaExpiresAt <= new Date()) throw new BadRequestException('Start the authenticator setup first');
      const secret = await unseal<string>(p.user.pendingMfaSecret, this.config.AUTH_SECRET);
      const verification = await verifyTotp({ secret, token: code, epochTolerance: 30 });
      if (!verification.valid || !('timeStep' in verification)) {
        await data.event('auth.mfa_failed', p.user.id, p.user.id, ctx.requestId);
        return null;
      }
      await data.updateUser(p.user.id, { mfaSecret: p.user.pendingMfaSecret, pendingMfaSecret: null, pendingMfaExpiresAt: null, lastTotpStep: verification.timeStep });
      const recoveryCodes = Array.from({ length: 10 }, opaqueToken);
      await data.replaceRecoveryCodes(p.user.id, recoveryCodes.map(digest));
      await data.signOutUserExcept(p.user.id, p.session.id);
      await data.event('auth.mfa_enrolled', p.user.id, p.user.id, ctx.requestId);
      return { recoveryCodes };
    });
    if (!result) throw new UnauthorizedException('Invalid or already used code');
    return result;
  }
  /** Security step-up (with the app). Refused while the store requires an authenticator app. */
  async disableAuthenticator(ctx: RequestContext) {
    return this.authenticated(ctx, { mutation: true, stepUp: 'security' }, async (data, p) => {
      if (!p.user.mfaSecret) throw new NotFoundException('No authenticator app is set up');
      if (p.tenant.settings?.mfaRequiredForAll) throw new ConflictException('This store requires an authenticator app');
      await data.updateUser(p.user.id, { mfaSecret: null, lastTotpStep: null, pendingMfaSecret: null, pendingMfaExpiresAt: null });
      await data.replaceRecoveryCodes(p.user.id, []);
      await data.event('auth.mfa_disabled', p.user.id, p.user.id, ctx.requestId);
      return { success: true };
    });
  }
  async regenerateRecoveryCodes(ctx: RequestContext) {
    return this.authenticated(ctx, { mutation: true, stepUp: 'security' }, async (data, p) => {
      if (!p.user.mfaSecret) throw new NotFoundException('No authenticator app is set up');
      const recoveryCodes = Array.from({ length: 10 }, opaqueToken);
      await data.replaceRecoveryCodes(p.user.id, recoveryCodes.map(digest));
      await data.event('auth.recovery_codes_regenerated', p.user.id, p.user.id, ctx.requestId);
      return { recoveryCodes };
    });
  }

  // ───────────── sessions screen ─────────────

  async listSessions(ctx: RequestContext) {
    return this.authenticated(ctx, { partial: true }, async (data, p) => ({
      items: (await data.userSessions(p.user.id)).map(s => ({
        id: s.id, current: s.id === p.session.id, deviceLabel: s.userAgent ?? 'Unknown device', trustedDevice: s.deviceId !== null,
        createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, idleExpiresAt: this.idleExpiry(s),
      })),
    }));
  }
  /** Signs out one session; a session on a trusted device also removes that device's trust. */
  async revokeSession(ctx: RequestContext, id: string) {
    return this.authenticated(ctx, { partial: true, mutation: true }, async (data, p) => {
      const target = (await data.userSessions(p.user.id)).find(s => s.id === id);
      if (!target) throw new NotFoundException('Session not found');
      if (target.deviceId) await data.deleteDevice(p.user.id, target.deviceId);
      else await data.deleteSession(target.id);
      await data.event('auth.session_revoked', p.user.id, target.id, ctx.requestId);
      return { success: true, current: target.id === p.session.id };
    });
  }
  async revokeAllSessions(ctx: RequestContext, includeCurrent: boolean) {
    return this.authenticated(ctx, { mutation: true, stepUp: 'security' }, async (data, p) => {
      const count = await data.signOutUserExcept(p.user.id, includeCurrent ? null : p.session.id);
      await data.event('auth.sessions_revoked_all', p.user.id, p.user.id, ctx.requestId, { count, includeCurrent });
      return { success: true, signedOut: count, current: includeCurrent };
    });
  }
  /** Owner only, single-use step-up: every session and trusted device of the store, the caller's own included. */
  async revokeStoreSessions(ctx: RequestContext) {
    return this.authenticated(ctx, { mutation: true, stepUp: 'single' }, async (data, p) => {
      if (p.member.role !== 'owner') throw new ForbiddenException('Only Owners can sign out the whole store');
      const count = await data.signOutStore();
      await data.event('auth.store_sessions_revoked', p.user.id, p.tenant.id, ctx.requestId, { count });
      return { success: true, signedOut: count };
    });
  }

  // ───────────── invitations and operations ─────────────

  async createInvitation(data: TenantData, email: string, role: Role, invitedBy: string | null, requestId: string) {
    if (await data.pendingInvitation(email)) throw new ConflictException('A pending invitation already exists; resend or revoke it');
    const user = await data.userByEmail(email);
    if (user && (await data.membership(user.id))?.active) throw new ConflictException('Already a team member');
    const token = opaqueToken();
    const invitation = await data.createInvitation({
      email, pendingEmail: email, role, tokenHash: digest(token), invitedBy,
      expiresAt: new Date(Date.now() + 48 * 3_600_000),
    });
    await this.invitationEmail(data, invitation, token);
    await data.event('invitation.created', invitedBy, invitation.id, requestId, { role });
    return { id: invitation.id, email, role, expiresAt: invitation.expiresAt };
  }
  /** A new single-use token and 48-hour expiry for an open invitation; the old token stops working at once. */
  private async rotateInvitation(data: TenantData, invitation: {id: string; email: string}, actorId: string | null, requestId: string) {
    const token = opaqueToken(), expiresAt = new Date(Date.now() + 48 * 3_600_000);
    await data.updateInvitation(invitation.id, { tokenHash: digest(token), expiresAt });
    await this.invitationEmail(data, invitation, token);
    await data.event('invitation.resent', actorId, invitation.id, requestId);
    return { id: invitation.id, expiresAt };
  }
  /**
   * Operations only (provision-store CLI). `marketplaces` preselects the store's marketplaces (explicit switches, all four
   * written) only while the store has no switches yet; afterwards they are changed in Settings, and a rerun leaves them.
   */
  async provision(input: {name: string; slug: string; hostname: string; ownerEmail: string; marketplaces?: readonly MarketplaceId[]}) {
    const tenant = await this.db.initialize({ name: input.name, slug: input.slug, hostname: input.hostname });
    return this.db.run(tenant.id, async data => {
      let marketplaces: 'set' | 'unchanged' | 'not_given' = 'not_given';
      if (input.marketplaces?.length) {
        if ((await data.recon.marketplaceSwitches()).length) marketplaces = 'unchanged';
        else {
          await data.settings.setMarketplaces(input.marketplaces);
          await data.event('settings.changed', null, null, 'operations', { field: 'marketplaces', old: [], new: [...input.marketplaces] });
          marketplaces = 'set';
        }
      }
      const existing = await data.firstOwnerInvitation();
      if (existing) {
        if (existing.email !== input.ownerEmail) throw new ConflictException('The initial Owner email differs');
        return { tenantId: tenant.id, invitationId: existing.id, created: false, marketplaces };
      }
      if (await data.ownerCount()) throw new ConflictException('Store already has an Owner');
      const invitation = await this.createInvitation(data, input.ownerEmail, 'owner', null, 'operations');
      await data.event('store.provisioned', null, tenant.id, 'operations');
      return { tenantId: tenant.id, invitationId: invitation.id, created: true, marketplaces };
    });
  }
  /**
   * Operations only (provision-store CLI): resend the Owner invitation of a store that has no active Owner yet, for
   * example after the 48-hour link expired. An open invitation (expired or not) gets a new token; if every Owner
   * invitation was revoked, a new one goes to the initial Owner email. Never returns the token.
   */
  async resendOwnerInvitation(tenantId: string) {
    return this.db.run(tenantId, async data => {
      if (await data.ownerCount()) throw new ConflictException('The store already has an active Owner; invitations are resent from Team');
      const open = await data.openOwnerInvitation();
      if (open) {
        const { expiresAt } = await this.rotateInvitation(data, open, null, 'operations');
        return { invitationId: open.id, expiresAt, created: false };
      }
      const first = await data.firstOwnerInvitation();
      if (!first) throw new NotFoundException('The store has no Owner invitation; run provisioning first');
      const invitation = await this.createInvitation(data, first.email, 'owner', null, 'operations');
      return { invitationId: invitation.id, expiresAt: invitation.expiresAt, created: true };
    });
  }
  /**
   * Operations only (provision-store recover-owner), after support has confirmed the Owner's identity outside Qorloop.
   * Signs the Owner out everywhere, moves the account to the new address and mails a password link there (24 hours) and
   * a notice to the old address. Never returns the link. The authenticator app, if any, is removed: the Owner sets a
   * new password and, if wanted, a new app.
   */
  async recoverOwner(tenantId: string, currentEmail: string, newEmail: string) {
    return this.db.run(tenantId, async data => {
      const user = await data.userByEmail(currentEmail);
      const member = user ? await data.membership(user.id) : null;
      if (!user || !member?.active || member.role !== 'owner') throw new NotFoundException('No active Owner with this address');
      if (currentEmail !== newEmail && await data.userByEmail(newEmail)) throw new ConflictException('Another account of this store uses the new address');
      const count = await data.signOutUserExcept(user.id, null);
      await data.invalidateResets(user.id);
      await data.updateUser(user.id, { email: newEmail, mfaSecret: null, lastTotpStep: null, pendingMfaSecret: null, pendingMfaExpiresAt: null });
      await data.replaceRecoveryCodes(user.id, []);
      const token = opaqueToken();
      const reset = await data.createReset({ userId: user.id, tokenHash: digest(token), expiresAt: new Date(Date.now() + DAY) });
      const tenant = await data.tenant();
      await this.mail(data, 'reset:' + reset.id, {
        to: newEmail, subject: 'Set your Qorloop password',
        text: 'Support has moved your Qorloop Owner account to this address. Set a new password (expires in 24 hours): ' + this.linkOrigin(tenant.hostname) + '/password/reset#token=' + token,
      });
      if (currentEmail !== newEmail) {
        await this.mail(data, 'recover-notice:' + reset.id, {
          to: currentEmail, subject: 'Your Qorloop Owner account was moved',
          text: `At your request, support moved your Qorloop Owner account to ${maskEmail(newEmail)}. If you did not ask for this, contact support at once.`,
        });
      }
      await data.event('support.owner_email_changed', null, user.id, 'operations', { signedOut: count });
      return { userId: user.id, signedOut: count };
    });
  }
  async resendInvitation(ctx: RequestContext, id: string) {
    return this.authenticated(ctx, { mutation: true, permission: 'team.invite' }, async (data, p) => {
      const invitation = await data.invitationById(id);
      if (!invitation || invitation.acceptedAt || invitation.revokedAt) throw new NotFoundException('Pending invitation not found');
      if (invitation.role === 'owner' && p.member.role !== 'owner') throw new ForbiddenException('Only Owners can manage Owner invitations');
      return this.rotateInvitation(data, invitation, p.user.id, ctx.requestId);
    });
  }
}
