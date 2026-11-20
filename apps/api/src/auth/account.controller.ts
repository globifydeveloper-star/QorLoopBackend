import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { AuthService } from './auth.service.js';
import { clearSessionCookies } from './auth.controller.js';

const dateTime = { type: 'string', format: 'date-time' };
const successSchema = { type: 'object', required: ['success'], properties: { success: { type: 'boolean' } } };
const recoveryCodesSchema = { type: 'object', properties: { recoveryCodes: { type: 'array', items: { type: 'string' }, description: 'Shown once' } } };

/** The signed-in user's own account (ADR 021). Sensitive actions need a fresh step-up; see each route. */
@ApiTags('Account') @ApiCookieAuth()
@Controller('api/account')
export class AccountController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(CONFIG) private readonly config: Config) {}

  @Get('sessions') @Access({ partial: true })
  @Contract('My signed-in devices: label, trusted device or shared computer, last use and expiry', undefined, {
    type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string', format: 'uuid' }, current: { type: 'boolean' }, deviceLabel: { type: 'string' }, trustedDevice: { type: 'boolean' },
      createdAt: dateTime, lastSeenAt: dateTime, expiresAt: dateTime, idleExpiresAt: dateTime,
    } } } },
  })
  sessions(@Req() req: AppRequest) { return this.auth.listSessions(context(req, this.config)); }

  @Delete('sessions/:id') @Access({ partial: true })
  @Contract('Sign out one device (no step-up: it only lowers risk); a trusted device also loses its trust', undefined, successSchema)
  async revoke(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.revokeSession(context(req, this.config), id);
    if (result.current) clearSessionCookies(this.config, reply, true);
    return { success: result.success };
  }

  @Post('sessions/revoke-all') @HttpCode(200) @Access({ stepUp: 'security' })
  @Contract('Sign out all my other devices (includeCurrent: this one too). Security step-up (10 minutes)', dto.revokeAllSessions, {
    type: 'object', properties: { success: { type: 'boolean' }, signedOut: { type: 'integer' } },
  })
  async revokeAll(@Req() req: AppRequest, @Body(new ZodPipe(dto.revokeAllSessions)) input: z.infer<typeof dto.revokeAllSessions>, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.revokeAllSessions(context(req, this.config), input.includeCurrent);
    if (result.current) clearSessionCookies(this.config, reply, true);
    return { success: result.success, signedOut: result.signedOut };
  }

  @Post('password') @HttpCode(200) @Access({ stepUp: 'security' })
  @Contract('Change my password (current password required); every other session and device is signed out. Security step-up', dto.changePassword, {
    type: 'object', properties: { success: { type: 'boolean' }, signedOut: { type: 'integer' } },
  })
  password(@Req() req: AppRequest, @Body(new ZodPipe(dto.changePassword)) input: z.infer<typeof dto.changePassword>) {
    return this.auth.changePassword(context(req, this.config), input);
  }

  @Post('email') @HttpCode(200) @Access({ stepUp: 'single' })
  @Contract('Change my sign-in address: a 24-hour link goes to the new address, a notice to the old one. Single-use step-up', dto.changeEmail, {
    type: 'object', properties: { pendingEmail: { type: 'string', description: 'Masked' }, expiresAt: dateTime },
  })
  email(@Req() req: AppRequest, @Body(new ZodPipe(dto.changeEmail)) input: z.infer<typeof dto.changeEmail>) {
    return this.auth.requestEmailChange(context(req, this.config), input.newEmail);
  }

  @Post('authenticator/setup') @HttpCode(200) @Access({ partial: true })
  @Contract('Start adding an authenticator app (optional, the stronger factor); password required', dto.mfaSetup, {
    type: 'object', required: ['totpUri', 'expiresIn'], properties: { totpUri: { type: 'string' }, expiresIn: { type: 'integer' } },
  })
  setupAuthenticator(@Req() req: AppRequest, @Body(new ZodPipe(dto.mfaSetup)) input: z.infer<typeof dto.mfaSetup>) {
    return this.auth.setupAuthenticator(context(req, this.config), input.password);
  }

  @Post('authenticator/verify') @HttpCode(200) @Access({ partial: true })
  @Contract('Confirm the app with its first code: enrolled, ten recovery codes returned once; other devices are signed out and from now on sign-in and step-up use the app', dto.mfaVerify, recoveryCodesSchema)
  confirmAuthenticator(@Req() req: AppRequest, @Body(new ZodPipe(dto.mfaVerify)) input: z.infer<typeof dto.mfaVerify>) {
    return this.auth.confirmAuthenticator(context(req, this.config), input.code);
  }

  @Delete('authenticator') @Access({ stepUp: 'security' })
  @Contract('Remove my authenticator app (back to emailed codes); refused while the store requires one. Security step-up', undefined, successSchema)
  disableAuthenticator(@Req() req: AppRequest) { return this.auth.disableAuthenticator(context(req, this.config)); }

  @Post('authenticator/recovery-codes') @HttpCode(200) @Access({ stepUp: 'security' })
  @Contract('Replace my recovery codes (the old ones stop working). Security step-up', undefined, recoveryCodesSchema)
  recoveryCodes(@Req() req: AppRequest) { return this.auth.regenerateRecoveryCodes(context(req, this.config)); }
}
