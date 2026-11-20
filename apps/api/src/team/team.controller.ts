import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { AuthService } from '../auth/auth.service.js';
import { clearSessionCookies } from '../auth/auth.controller.js';
import { TeamService } from './team.service.js';

/** Inviting, resending, role changes and removal need a fresh code within 10 minutes (security step-up, ADR 021). */
@ApiTags('Team')
@ApiCookieAuth()
@Controller('api/team')
export class TeamController {
  constructor(@Inject(TeamService) private readonly team: TeamService, @Inject(AuthService) private readonly auth: AuthService, @Inject(CONFIG) private readonly config: Config) {}
  @Get('members') @Access({ permission: 'team.view' })
  @Contract('List active team members', undefined, { type: 'array', items: { type: 'object' } })
  members(@Req() req: AppRequest) { return this.team.list(context(req, this.config)); }
  @Get('invitations') @Access({ permission: 'team.invite' })
  @Contract('List unaccepted, unrevoked invitations (including expired invitations)', undefined, { type: 'array', items: { type: 'object' } })
  invitations(@Req() req: AppRequest) { return this.team.invitations(context(req, this.config)); }
  @Post('invitations') @HttpCode(200) @Access({ permission: 'team.invite', stepUp: 'security' })
  @Contract('Invite a member; only an Owner can invite another Owner. Security step-up', dto.inviteMember)
  invite(@Req() req: AppRequest, @Body(new ZodPipe(dto.inviteMember)) input: z.infer<typeof dto.inviteMember>) { return this.team.invite(context(req, this.config), input.email, input.role); }
  @Post('invitations/:id/resend') @HttpCode(200) @Access({ permission: 'team.invite', stepUp: 'security' })
  @Contract('Rotate an invitation token and queue a new email. Security step-up')
  resend(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.auth.resendInvitation(context(req, this.config), id); }
  @Delete('invitations/:id') @Access({ permission: 'team.invite' })
  @Contract('Revoke an unaccepted invitation (no step-up: it only lowers risk)')
  revoke(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.team.revoke(context(req, this.config), id); }
  @Patch('members/:id/role') @Access({ permission: 'team.manage_roles', stepUp: 'security' })
  @Contract('Change role, sign the member out on every device and retain at least one active Owner. Security step-up', dto.changeRole)
  changeRole(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.changeRole)) input: z.infer<typeof dto.changeRole>) { return this.team.changeRole(context(req, this.config), id, input.role); }
  @Delete('members/:id') @Access({ permission: 'team.remove', stepUp: 'security' })
  @Contract('Deactivate a member and sign them out on every device. Security step-up')
  remove(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.team.remove(context(req, this.config), id); }
  @Post('sessions/revoke-all') @HttpCode(200) @Access({ permission: 'team.manage_roles', stepUp: 'single' })
  @Contract("Owner only: sign out every session and trusted device of the store, the caller's own included. Single-use step-up", undefined, {
    type: 'object', properties: { success: { type: 'boolean' }, signedOut: { type: 'integer' } },
  })
  async revokeStore(@Req() req: AppRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.revokeStoreSessions(context(req, this.config));
    clearSessionCookies(this.config, reply, true);
    return result;
  }
}
