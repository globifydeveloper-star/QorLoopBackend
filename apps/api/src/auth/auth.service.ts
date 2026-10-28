import { Inject, Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import { z } from 'zod';
import { Database, type TenantData, type Role } from '../../../../packages/db/src/database.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import * as contracts from '../../../../packages/shared/src/contracts.js';
import { digest, opaqueToken, hashPassword, verifyPassword, matchesDigest, seal, unseal } from '../../../../packages/shared/src/security.js';
import { hasPermission, type Permission } from '../../../../packages/core/src/roles.js';
import { CONFIG } from '../tokens.js';

export interface RequestContext {
  tenantId: string;
  requestId: string;
  token?: string;
  csrf?: string;
}
export type Principal = Awaited<ReturnType<AuthService['checkSession']>>;
type SessionIssue = { token: string; csrfToken: string; expiresAt: Date; state: string };
export type MailMessage = { to: string; subject: string; text: string };

@Injectable()
export class AuthService {
  private readonly dummyHash = hashPassword(opaqueToken());
  constructor(@Inject(Database) private readonly db: Database, @Inject(CONFIG) private readonly config: Config) {}

  private state(assurance: string) {
    return assurance === 'full' ? 'authenticated' : assurance === 'challenge' ? 'mfa_required' : 'mfa_setup_required';
  }
  private async issue(data: TenantData, userId: string, assurance: 'full' | 'enrollment' | 'challenge'): Promise<SessionIssue> {
    const token = opaqueToken(), csrfToken = opaqueToken();
    const expiresAt = new Date(Date.now() + (assurance === 'full' ? this.config.SESSION_HOURS * 3_600_000 : 600_000));
    await data.createSession({ userId, tokenHash: digest(token), csrfHash: digest(csrfToken), assurance, expiresAt });
    return { token, csrfToken, expiresAt, state: this.state(assurance) };
  }
  private async assurance(data: TenantData, user: {mfaSecret: string | null}, role: Role) {
    if (user.mfaSecret) return 'challenge' as const;
    const tenant = await data.tenant();
    return role === 'owner' || tenant.settings?.mfaRequiredForAll ? 'enrollment' as const : 'full' as const;
  }
  async checkSession(data: TenantData, ctx: RequestContext, options: { partial?: boolean; mutation?: boolean; permission?: Permission } = {}) {
    const session = ctx.token ? await data.sessionByHash(digest(ctx.token)) : null;
    if (!session || session.expiresAt <= new Date() || session.lastSeenAt.getTime() + this.config.SESSION_IDLE_MINUTES * 60_000 <= Date.now()) {
      throw new UnauthorizedException('Session expired or invalid');
    }
    const member = await data.membership(session.userId);
    if (!member?.active) throw new UnauthorizedException('Session expired or invalid');
    if (options.mutation && (!ctx.csrf || !matchesDigest(ctx.csrf, session.csrfHash))) throw new ForbiddenException('CSRF token required');
    const tenant = await data.tenant();
    if (!options.partial && (session.assurance !== 'full' || ((member.role === 'owner' || tenant.settings?.mfaRequiredForAll) && !session.user.mfaSecret))) {
      throw new ForbiddenException('MFA verification required');
    }
    if (options.permission && !hasPermission(member.role, options.permission, tenant.settings?.analystCanExport ?? true)) {
      throw new ForbiddenException('Permission denied');
    }
    await data.touchSession(session.id);
    return { session, user: session.user, member, tenant };
  }
  authenticated<T>(ctx: RequestContext, options: {partial?: boolean; mutation?: boolean; permission?: Permission}, action: (data: TenantData, principal: Principal) => Promise<T>) {
    return this.db.run(ctx.tenantId, async data => action(data, await this.checkSession(data, ctx, options)));
  }
  private publicUser(user: {id: string; email: string; name: string}) { return { id: user.id, email: user.email, name: user.name }; }

  async accept(ctx: RequestContext, input: z.infer<typeof contracts.acceptInvitation>) {
    const passwordHash = await hashPassword(input.password);
    return this.db.run(ctx.tenantId, async data => {
      const invite = await data.invitationByHash(digest(input.token));
      if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= new Date()) throw new BadRequestException('Invitation expired or invalid');
      let user = await data.userByEmail(invite.email);
      let member = user ? await data.membership(user.id) : null;
      if (member?.active) throw new ConflictException('Already a team member');
      if (user) {
        await data.updateUser(user.id, { passwordHash });
        await data.deleteUserSessions(user.id);
        await data.invalidateResets(user.id);
      } else {
        user = await data.createUser({ email: invite.email, name: input.name, passwordHash, emailVerifiedAt: new Date() });
      }
      if (member) await data.updateMembership(member.id, { active: true, role: invite.role });
      else member = await data.createMembership(user.id, invite.role);
      await data.updateInvitation(invite.id, { acceptedAt: new Date(), pendingEmail: null });
      await data.event('invitation.accepted', user.id, invite.id, ctx.requestId, { role: invite.role });
      return this.issue(data, user.id, await this.assurance(data, user, invite.role));
    });
  }
  async login(ctx: RequestContext, input: z.infer<typeof contracts.login>) {
    const result = await this.db.run(ctx.tenantId, async data => {
      const user = await data.userByEmail(input.email);
      const valid = await verifyPassword(input.password, user?.passwordHash ?? await this.dummyHash);
      const member = user ? await data.membership(user.id) : null;
      if (!valid || !user || !member?.active) {
        await data.event('auth.login_failed', null, null, ctx.requestId);
        return null;
      }
      await data.event('auth.password_verified', user.id, user.id, ctx.requestId);
      return this.issue(data, user.id, await this.assurance(data, user, member.role));
    });
    if (!result) throw new UnauthorizedException('Invalid email or password');
    return result;
  }
  async me(ctx: RequestContext) {
    return this.authenticated(ctx, {}, async (_data, p) => ({
      user: this.publicUser(p.user), role: p.member.role,
      permissions: (await import('../../../../packages/core/src/roles.js')).ROLE_PERMISSIONS[p.member.role]
        .filter(permission => hasPermission(p.member.role, permission, p.tenant.settings?.analystCanExport ?? true)),
      tenant: { id: p.tenant.id, name: p.tenant.name, slug: p.tenant.slug },
      mfaEnabled: Boolean(p.user.mfaSecret), expiresAt: p.session.expiresAt,
    }));
  }
  async logout(ctx: RequestContext) {
    return this.authenticated(ctx, { partial: true, mutation: true }, async (data, p) => {
      await data.deleteSession(p.session.id);
      await data.event('auth.logout', p.user.id, p.session.id, ctx.requestId);
      return { success: true };
    });
  }
  private async mail(data: TenantData, key: string, message: MailMessage) {
    await data.queueMail(key, await seal(message, this.config.AUTH_SECRET));
  }
  private async invitationEmail(data: TenantData, invitation: {id: string; email: string}, token: string) {
    const tenant = await data.tenant();
    // Origin comes only from configuration and the stored, operations-controlled host.
    const origin = this.config.NODE_ENV === 'production' ? 'https://' + tenant.hostname : this.config.APP_ORIGIN.replace(new URL(this.config.APP_ORIGIN).hostname, tenant.hostname);
    await this.mail(data, 'invitation:' + invitation.id + ':' + digest(token), {
      to: invitation.email, subject: 'Your Qorloop invitation',
      text: 'Accept your invitation (expires in 48 hours): ' + origin + '/invitations/accept#token=' + token,
    });
  }
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
  async provision(input: {name: string; slug: string; hostname: string; ownerEmail: string}) {
    const tenant = await this.db.initialize({ name: input.name, slug: input.slug, hostname: input.hostname });
    return this.db.run(tenant.id, async data => {
      const existing = await data.firstOwnerInvitation();
      if (existing) {
        if (existing.email !== input.ownerEmail) throw new ConflictException('The initial Owner email differs');
        return { tenantId: tenant.id, invitationId: existing.id, created: false };
      }
      if (await data.ownerCount()) throw new ConflictException('Store already has an Owner');
      const invitation = await this.createInvitation(data, input.ownerEmail, 'owner', null, 'operations');
      await data.event('store.provisioned', null, tenant.id, 'operations');
      return { tenantId: tenant.id, invitationId: invitation.id, created: true };
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
      const origin = this.config.NODE_ENV === 'production' ? 'https://' + tenant.hostname : this.config.APP_ORIGIN.replace(new URL(this.config.APP_ORIGIN).hostname, tenant.hostname);
      await this.mail(data, 'reset:' + reset.id, {
        to: email, subject: 'Reset your Qorloop password',
        text: 'Reset your password (expires in 30 minutes): ' + origin + '/password/reset#token=' + token,
      });
      await data.event('auth.password_reset_requested', user.id, reset.id, ctx.requestId);
    });
    return { success: true };
  }
  async reset(ctx: RequestContext, input: z.infer<typeof contracts.resetPassword>) {
    const passwordHash = await hashPassword(input.password);
    return this.db.run(ctx.tenantId, async data => {
      const reset = await data.resetByHash(digest(input.token));
      if (!reset || reset.usedAt || reset.expiresAt <= new Date()) throw new BadRequestException('Reset token expired or invalid');
      if (!(await data.membership(reset.userId))?.active) throw new BadRequestException('Reset token expired or invalid');
      await data.updateUser(reset.userId, { passwordHash });
      await data.invalidateResets(reset.userId);
      await data.deleteUserSessions(reset.userId);
      await data.event('auth.password_reset', reset.userId, reset.id, ctx.requestId);
      return { success: true };
    });
  }
  async setupMfa(ctx: RequestContext, password: string) {
    return this.authenticated(ctx, { partial: true, mutation: true }, async (data, p) => {
      if (p.user.mfaSecret) throw new ConflictException('MFA already enrolled');
      if (!await verifyPassword(password, p.user.passwordHash)) throw new UnauthorizedException('Invalid credentials');
      const secret = generateSecret();
      await data.updateUser(p.user.id, {
        pendingMfaSecret: await seal(secret, this.config.AUTH_SECRET),
        pendingMfaExpiresAt: new Date(Date.now() + 600_000),
      });
      await data.event('auth.mfa_setup_started', p.user.id, p.user.id, ctx.requestId);
      return { totpUri: generateURI({ issuer: 'Qorloop', label: p.tenant.slug + ':' + p.user.email, secret }), expiresIn: 600 };
    });
  }
  async verifyMfa(ctx: RequestContext, code: string) {
    const result = await this.authenticated(ctx, { partial: true, mutation: true }, async (data, p) => {
      const enrolling = !p.user.mfaSecret;
      const encrypted = p.user.mfaSecret ?? p.user.pendingMfaSecret;
      if (!encrypted || (enrolling && (!p.user.pendingMfaExpiresAt || p.user.pendingMfaExpiresAt <= new Date()))) throw new BadRequestException('Start MFA setup first');
      const secret = await unseal<string>(encrypted, this.config.AUTH_SECRET);
      const verification = await verifyTotp({ secret, token: code, epochTolerance: 30, ...(p.user.lastTotpStep == null ? {} : { afterTimeStep: p.user.lastTotpStep }) });
      if (!verification.valid || !('timeStep' in verification)) {
        await data.event('auth.mfa_failed', p.user.id, p.user.id, ctx.requestId);
        return null;
      }
      await data.updateUser(p.user.id, {
        mfaSecret: encrypted, pendingMfaSecret: null, pendingMfaExpiresAt: null, lastTotpStep: verification.timeStep,
      });
      const recoveryCodes = enrolling ? Array.from({ length: 10 }, opaqueToken) : undefined;
      if (recoveryCodes) await data.replaceRecoveryCodes(p.user.id, recoveryCodes.map(digest));
      if (enrolling) await data.deleteUserSessions(p.user.id);
      else await data.deleteSession(p.session.id);
      await data.event(enrolling ? 'auth.mfa_enrolled' : 'auth.mfa_verified', p.user.id, p.user.id, ctx.requestId);
      return { ...await this.issue(data, p.user.id, 'full'), ...(recoveryCodes ? { recoveryCodes } : {}) };
    });
    if (!result) throw new UnauthorizedException('Invalid or already used MFA code');
    return result;
  }
  async recoverMfa(ctx: RequestContext, code: string) {
    const result = await this.authenticated(ctx, { partial: true, mutation: true }, async (data, p) => {
      if (!p.user.mfaSecret || p.session.assurance !== 'challenge') throw new BadRequestException('MFA challenge required');
      if (!(await data.consumeRecovery(p.user.id, digest(code))).count) {
        await data.event('auth.recovery_failed', p.user.id, p.user.id, ctx.requestId);
        return null;
      }
      await data.deleteSession(p.session.id);
      await data.event('auth.recovery_used', p.user.id, p.user.id, ctx.requestId);
      return this.issue(data, p.user.id, 'full');
    });
    if (!result) throw new UnauthorizedException('Invalid recovery code');
    return result;
  }
  async resendInvitation(ctx: RequestContext, id: string) {
    return this.authenticated(ctx, { mutation: true, permission: 'team.invite' }, async (data, p) => {
      const invitation = await data.invitationById(id);
      if (!invitation || invitation.acceptedAt || invitation.revokedAt) throw new NotFoundException('Pending invitation not found');
      if (invitation.role === 'owner' && p.member.role !== 'owner') throw new ForbiddenException('Only Owners can manage Owner invitations');
      const token = opaqueToken(), expiresAt = new Date(Date.now() + 48 * 3_600_000);
      await data.updateInvitation(id, { tokenHash: digest(token), expiresAt });
      await this.invitationEmail(data, invitation, token);
      await data.event('invitation.resent', p.user.id, id, ctx.requestId);
      return { id, expiresAt };
    });
  }
}

