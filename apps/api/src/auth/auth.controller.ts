import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { CONFIG } from '../tokens.js';
import { Access, context, cookieName, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { AuthService } from './auth.service.js';

const sessionSchema = {
  type: 'object', required: ['state', 'csrfToken', 'expiresAt'], properties: {
    state: { type: 'string', enum: ['authenticated', 'mfa_setup_required', 'mfa_required'] },
    csrfToken: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' },
    recoveryCodes: { type: 'array', items: { type: 'string' }, description: 'Returned once, after enrollment verification only' },
  },
};
const successSchema = { type: 'object', required: ['success'], properties: { success: { type: 'boolean' } } };
@ApiTags('Authentication')
@ApiCookieAuth()
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(CONFIG) private readonly config: Config) {}
  private finish(reply: FastifyReply, result: {token: string; csrfToken: string; expiresAt: Date; state: string; recoveryCodes?: string[]}) {
    reply.setCookie(cookieName(this.config), result.token, {
      path: '/', httpOnly: true, secure: this.config.NODE_ENV === 'production', sameSite: 'strict',
      expires: result.expiresAt,
    });
    reply.setCookie(cookieName(this.config) + '.csrf', result.csrfToken, {
      path: '/', httpOnly: false, secure: this.config.NODE_ENV === 'production', sameSite: 'strict', expires: result.expiresAt,
    });
    return { state: result.state, csrfToken: result.csrfToken, expiresAt: result.expiresAt, ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}) };
  }
  @Post('invitations/accept') @HttpCode(200) @Access({ public: true })
  @Contract('Accept a single-use tenant invitation and set a password', dto.acceptInvitation, sessionSchema)
  async accept(@Req() req: AppRequest, @Body(new ZodPipe(dto.acceptInvitation)) input: z.infer<typeof dto.acceptInvitation>, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.finish(reply, await this.auth.accept(context(req, this.config), input));
  }
  @Post('login') @HttpCode(200) @Access({ public: true })
  @Contract('Verify password; MFA states grant no business access', dto.login, sessionSchema)
  async login(@Req() req: AppRequest, @Body(new ZodPipe(dto.login)) input: z.infer<typeof dto.login>, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.finish(reply, await this.auth.login(context(req, this.config), input));
  }
  @Post('logout') @HttpCode(200) @Access({ partial: true })
  @Contract('Invalidate the current full or restricted session', undefined, successSchema)
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.logout(context(req, this.config));
    const options = { path: '/', secure: this.config.NODE_ENV === 'production', sameSite: 'strict' as const };
    reply.clearCookie(cookieName(this.config), { ...options, httpOnly: true });
    reply.clearCookie(cookieName(this.config) + '.csrf', options);
    return result;
  }
  @Post('password/forgot') @HttpCode(200) @Access({ public: true })
  @Contract('Request a reset; same response for known and unknown addresses', dto.forgotPassword, successSchema)
  forgot(@Req() req: AppRequest, @Body(new ZodPipe(dto.forgotPassword)) input: z.infer<typeof dto.forgotPassword>) {
    return this.auth.forgot(context(req, this.config), input.email);
  }
  @Post('password/reset') @HttpCode(200) @Access({ public: true })
  @Contract('Consume a reset token and revoke all user sessions; MFA remains enrolled', dto.resetPassword, successSchema)
  reset(@Req() req: AppRequest, @Body(new ZodPipe(dto.resetPassword)) input: z.infer<typeof dto.resetPassword>) {
    return this.auth.reset(context(req, this.config), input);
  }
  @Post('mfa/setup') @HttpCode(200) @Access({ partial: true })
  @Contract('Start TOTP enrollment after password confirmation', dto.mfaSetup, { type: 'object', required: ['totpUri', 'expiresIn'], properties: { totpUri: { type: 'string' }, expiresIn: { type: 'integer' } } })
  setup(@Req() req: AppRequest, @Body(new ZodPipe(dto.mfaSetup)) input: z.infer<typeof dto.mfaSetup>) {
    return this.auth.setupMfa(context(req, this.config), input.password);
  }
  @Post('mfa/verify') @HttpCode(200) @Access({ partial: true })
  @Contract('Verify enrollment or a login challenge and rotate the session', dto.mfaVerify, sessionSchema)
  async verify(@Req() req: AppRequest, @Body(new ZodPipe(dto.mfaVerify)) input: z.infer<typeof dto.mfaVerify>, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.finish(reply, await this.auth.verifyMfa(context(req, this.config), input.code));
  }
  @Post('mfa/recovery') @HttpCode(200) @Access({ partial: true })
  @Contract('Consume one recovery code during a password-authenticated MFA challenge', dto.mfaRecovery, sessionSchema)
  async recovery(@Req() req: AppRequest, @Body(new ZodPipe(dto.mfaRecovery)) input: z.infer<typeof dto.mfaRecovery>, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.finish(reply, await this.auth.recoverMfa(context(req, this.config), input.code));
  }
  @Get('me') @Access({})
  @Contract('Read the authenticated profile, effective permissions and store context')
  me(@Req() req: AppRequest) { return this.auth.me(context(req, this.config)); }
}

