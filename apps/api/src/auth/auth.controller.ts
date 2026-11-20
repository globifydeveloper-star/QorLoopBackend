import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { CONFIG } from '../tokens.js';
import { Access, challengeCookieName, context, cookieName, deviceCookieName, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { AuthService, type ChallengeIssue, type SessionIssue } from './auth.service.js';

const dateTime = { type: 'string', format: 'date-time' };
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };
const sessionSchema = {
  type: 'object', required: ['state', 'csrfToken', 'expiresAt'], properties: {
    state: { type: 'string', enum: ['authenticated', 'authenticator_setup_required'] },
    csrfToken: { type: 'string' }, expiresAt: { ...dateTime, description: 'The hard limit: 20 days from sign-in (12 hours on a shared computer)' },
  },
};
const challengeSchema = {
  type: 'object', required: ['state', 'challengeExpiresAt', 'resendAvailableAt', 'maskedEmail'], properties: {
    state: { type: 'string', enum: ['otp_required', 'totp_required'], description: 'otp_required: a code was emailed; totp_required: the authenticator app (or a recovery code)' },
    challengeExpiresAt: dateTime, resendAvailableAt: { ...nullableDateTime, description: 'null: no more codes for this sign-in' },
    maskedEmail: { type: ['string', 'null'] },
  },
};
const loginSchema = { oneOf: [sessionSchema, challengeSchema] };
const stepUpWindows = { type: 'object', properties: { securityValidUntil: nullableDateTime, workValidUntil: nullableDateTime } };
const successSchema = { type: 'object', required: ['success'], properties: { success: { type: 'boolean' } } };

/** Cookies of the session issue: session and CSRF (until the hard limit), the device cookie when the device is new. */
export function setSessionCookies(config: Config, reply: FastifyReply, result: SessionIssue) {
  const secure = config.NODE_ENV === 'production';
  reply.setCookie(cookieName(config), result.token, { path: '/', httpOnly: true, secure, sameSite: 'strict', expires: result.expiresAt });
  reply.setCookie(cookieName(config) + '.csrf', result.csrfToken, { path: '/', httpOnly: false, secure, sameSite: 'strict', expires: result.expiresAt });
  if (result.device) reply.setCookie(deviceCookieName(config), result.device.token, { path: '/', httpOnly: true, secure, sameSite: 'strict', expires: result.device.expiresAt });
  reply.clearCookie(challengeCookieName(config), { path: '/', httpOnly: true, secure, sameSite: 'strict' });
  return { state: result.state, csrfToken: result.csrfToken, expiresAt: result.expiresAt, ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}) };
}
/** Clears the session cookies; `device` also forgets this browser's trust (a store-wide or device sign-out). */
export function clearSessionCookies(config: Config, reply: FastifyReply, device = false) {
  const options = { path: '/', secure: config.NODE_ENV === 'production', sameSite: 'strict' as const };
  reply.clearCookie(cookieName(config), { ...options, httpOnly: true });
  reply.clearCookie(cookieName(config) + '.csrf', options);
  if (device) reply.clearCookie(deviceCookieName(config), { ...options, httpOnly: true });
}

@ApiTags('Authentication')
@ApiCookieAuth()
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(CONFIG) private readonly config: Config) {}
  private finish(reply: FastifyReply, result: SessionIssue | ChallengeIssue) {
    if (result.kind === 'session') return setSessionCookies(this.config, reply, result);
    reply.setCookie(challengeCookieName(this.config), result.challengeToken, {
      path: '/', httpOnly: true, secure: this.config.NODE_ENV === 'production', sameSite: 'strict', expires: new Date(Date.now() + 10 * 60_000),
    });
    return { state: result.state, challengeExpiresAt: result.challengeExpiresAt, resendAvailableAt: result.resendAvailableAt, maskedEmail: result.maskedEmail };
  }
  @Post('invitations/accept') @HttpCode(200) @Access({ public: true })
  @Contract('Accept a single-use invitation and set a password; the browser becomes a trusted device and a session starts', dto.acceptInvitation, sessionSchema)
  async accept(@Req() req: AppRequest, @Body(new ZodPipe(dto.acceptInvitation)) input: z.infer<typeof dto.acceptInvitation>, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.finish(reply, await this.auth.accept(context(req, this.config), input));
  }
  @Post('login') @HttpCode(200) @Access({ public: true })
  @Contract("Verify the password. On this user's trusted device: a session. Otherwise a challenge (emailed code, or the authenticator app when enrolled) in a 10-minute challenge cookie. 429 OTP_SEND_LIMIT when no code may be sent", dto.login, loginSchema)
  async login(@Req() req: AppRequest, @Body(new ZodPipe(dto.login)) input: z.infer<typeof dto.login>, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.finish(reply, await this.auth.login(context(req, this.config), input));
  }
  @Post('otp/verify') @HttpCode(200) @Access({ public: true })
  @Contract('Complete a sign-in with the emailed or app code (challenge cookie). 401 OTP_INVALID (meta.attemptsLeft), OTP_LOCKED after five wrong codes, CHALLENGE_EXPIRED', dto.otpCode, sessionSchema)
  async verifyOtp(@Req() req: AppRequest, @Body(new ZodPipe(dto.otpCode)) input: z.infer<typeof dto.otpCode>, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.finish(reply, await this.auth.verifyLogin(context(req, this.config), { code: input.code }));
  }
  @Post('otp/recovery') @HttpCode(200) @Access({ public: true })
  @Contract('Complete an authenticator sign-in with one recovery code instead (consumed)', dto.mfaRecovery, sessionSchema)
  async recovery(@Req() req: AppRequest, @Body(new ZodPipe(dto.mfaRecovery)) input: z.infer<typeof dto.mfaRecovery>, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.finish(reply, await this.auth.verifyLogin(context(req, this.config), { recoveryCode: input.code }));
  }
  @Post('otp/resend') @HttpCode(200) @Access({ public: true })
  @Contract('Email a new code for the pending sign-in; the previous code stops working. 60 s apart, three per sign-in, five per hour per user, 30 per hour per store (429 OTP_SEND_LIMIT)', undefined, {
    type: 'object', properties: { challengeExpiresAt: dateTime, resendAvailableAt: nullableDateTime },
  })
  resend(@Req() req: AppRequest) { return this.auth.resendLogin(context(req, this.config)); }
  @Post('logout') @HttpCode(200) @Access({ partial: true })
  @Contract('End the current session; the device stays trusted', undefined, successSchema)
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.logout(context(req, this.config));
    clearSessionCookies(this.config, reply);
    return result;
  }
  @Post('password/forgot') @HttpCode(200) @Access({ public: true })
  @Contract('Request a reset; same response for known and unknown addresses', dto.forgotPassword, successSchema)
  forgot(@Req() req: AppRequest, @Body(new ZodPipe(dto.forgotPassword)) input: z.infer<typeof dto.forgotPassword>) {
    return this.auth.forgot(context(req, this.config), input.email);
  }
  @Post('password/reset') @HttpCode(200) @Access({ public: true })
  @Contract('Consume a reset token; signs the user out everywhere, trusted devices included; the authenticator app stays enrolled', dto.resetPassword, successSchema)
  reset(@Req() req: AppRequest, @Body(new ZodPipe(dto.resetPassword)) input: z.infer<typeof dto.resetPassword>) {
    return this.auth.reset(context(req, this.config), input);
  }
  @Post('email/confirm') @HttpCode(200) @Access({ public: true })
  @Contract('Confirm a new sign-in address with the emailed link token; signs the user out everywhere', dto.confirmEmail, successSchema)
  confirmEmail(@Req() req: AppRequest, @Body(new ZodPipe(dto.confirmEmail)) input: z.infer<typeof dto.confirmEmail>) {
    return this.auth.confirmEmailChange(context(req, this.config), input.token);
  }
  @Post('step-up/start') @HttpCode(200) @Access({})
  @Contract('Ask for a fresh code inside the session (emailed, or the authenticator app) before a sensitive action', undefined, {
    type: 'object', properties: { method: { type: 'string', enum: ['email', 'totp'] }, expiresAt: dateTime, resendAvailableAt: nullableDateTime, maskedEmail: { type: ['string', 'null'] } },
  })
  startStepUp(@Req() req: AppRequest) { return this.auth.startStepUp(context(req, this.config)); }
  @Post('step-up/verify') @HttpCode(200) @Access({})
  @Contract('Verify the fresh code ({code}, or {recoveryCode} for authenticator users): opens the security (10 min) and work (30 min) windows', dto.stepUpVerify, stepUpWindows)
  verifyStepUp(@Req() req: AppRequest, @Body(new ZodPipe(dto.stepUpVerify)) input: z.infer<typeof dto.stepUpVerify>) {
    return this.auth.verifyStepUp(context(req, this.config), 'code' in input ? { code: input.code } : { recoveryCode: input.recoveryCode });
  }
  @Get('me') @Access({})
  @Contract('Read the authenticated profile, effective permissions, store context and step-up windows')
  me(@Req() req: AppRequest) { return this.auth.me(context(req, this.config)); }
  @Get('session') @Access({ public: true })
  @Contract('Session state without extending idle expiry; 401 UNAUTHENTICATED or SESSION_EXPIRED', undefined, {
    type: 'object', properties: {
      state: { type: 'string', enum: ['authenticated', 'authenticator_setup_required'] },
      expiresAt: dateTime, idleExpiresAt: dateTime, nextAction: { type: 'string', enum: ['none', 'setup_authenticator'] },
      securityValidUntil: nullableDateTime, workValidUntil: nullableDateTime,
    },
  })
  session(@Req() req: AppRequest) { return this.auth.sessionStatus(context(req, this.config)); }
}
