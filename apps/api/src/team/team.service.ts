import { Inject, Injectable, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type { Role } from '../../../../packages/db/src/database.js';

@Injectable()
export class TeamService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  list(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'team.view' }, async data =>
      (await data.members()).map(member => ({
        id: member.id, role: member.role, active: member.active, createdAt: member.createdAt,
        user: { id: member.user.id, email: member.user.email, name: member.user.name, mfaEnabled: Boolean(member.user.mfaSecret) },
      })),
    );
  }
  invitations(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'team.invite' }, data => data.invitations());
  }
  invite(ctx: RequestContext, email: string, role: Role) {
    return this.auth.authenticated(ctx, { permission: 'team.invite', mutation: true }, async (data, p) => {
      if (role === 'owner' && p.member.role !== 'owner') throw new ForbiddenException('Only Owners can grant Owner permissions');
      return this.auth.createInvitation(data, email, role, p.user.id, ctx.requestId);
    });
  }
  revoke(ctx: RequestContext, id: string) {
    return this.auth.authenticated(ctx, { permission: 'team.invite', mutation: true }, async (data, p) => {
      const invitation = await data.invitationById(id);
      if (!invitation || invitation.acceptedAt || invitation.revokedAt) throw new NotFoundException('Pending invitation not found');
      if (invitation.role === 'owner' && p.member.role !== 'owner') throw new ForbiddenException('Only Owners can manage Owner invitations');
      await data.updateInvitation(id, { revokedAt: new Date(), pendingEmail: null });
      await data.event('invitation.revoked', p.user.id, id, ctx.requestId);
      return { success: true };
    });
  }
  changeRole(ctx: RequestContext, id: string, role: Role) {
    return this.auth.authenticated(ctx, { permission: 'team.manage_roles', mutation: true }, async (data, p) => {
      const member = await data.memberById(id);
      if (!member?.active) throw new NotFoundException('Member not found');
      if ((member.role === 'owner' || role === 'owner') && p.member.role !== 'owner') throw new ForbiddenException('Only Owners can manage Owner permissions');
      if (member.role === 'owner' && role !== 'owner' && await data.ownerCount() <= 1) throw new ConflictException('The store must retain an active Owner');
      await data.updateMembership(id, { role });
      await data.deleteUserSessions(member.userId);
      await data.event('team.role_changed', p.user.id, id, ctx.requestId, { from: member.role, to: role });
      return { id, role };
    });
  }
  remove(ctx: RequestContext, id: string) {
    return this.auth.authenticated(ctx, { permission: 'team.remove', mutation: true }, async (data, p) => {
      const member = await data.memberById(id);
      if (!member?.active) throw new NotFoundException('Member not found');
      if (member.role === 'owner' && p.member.role !== 'owner') throw new ForbiddenException('Only Owners can remove Owners');
      if (member.role === 'owner' && await data.ownerCount() <= 1) throw new ConflictException('The store must retain an active Owner');
      await data.updateMembership(id, { active: false });
      await data.deleteUserSessions(member.userId);
      await data.invalidateResets(member.userId);
      await data.event('team.member_deactivated', p.user.id, id, ctx.requestId);
      return { success: true };
    });
  }
}

