import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import * as dto from '../../../../packages/shared/src/contracts.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import { CONFIG } from '../tokens.js';
import { Access, context, type AppRequest } from '../http/security.guard.js';
import { Contract, ZodPipe } from '../http/contracts.js';
import { AuthService } from '../auth/auth.service.js';
import { TeamService } from './team.service.js';

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
  @Post('invitations') @HttpCode(200) @Access({ permission: 'team.invite' })
  @Contract('Invite a member; only an Owner can invite another Owner', dto.inviteMember)
  invite(@Req() req: AppRequest, @Body(new ZodPipe(dto.inviteMember)) input: z.infer<typeof dto.inviteMember>) { return this.team.invite(context(req, this.config), input.email, input.role); }
  @Post('invitations/:id/resend') @HttpCode(200) @Access({ permission: 'team.invite' })
  @Contract('Rotate an invitation token and queue a new email')
  resend(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.auth.resendInvitation(context(req, this.config), id); }
  @Delete('invitations/:id') @Access({ permission: 'team.invite' })
  @Contract('Revoke an unaccepted invitation')
  revoke(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.team.revoke(context(req, this.config), id); }
  @Patch('members/:id/role') @Access({ permission: 'team.manage_roles' })
  @Contract('Change role, revoke sessions and retain at least one active Owner', dto.changeRole)
  changeRole(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(dto.changeRole)) input: z.infer<typeof dto.changeRole>) { return this.team.changeRole(context(req, this.config), id, input.role); }
  @Delete('members/:id') @Access({ permission: 'team.remove' })
  @Contract('Deactivate a member and revoke their sessions')
  remove(@Req() req: AppRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.team.remove(context(req, this.config), id); }
}

