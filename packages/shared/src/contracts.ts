import { z } from 'zod';
export const email = z.string().trim().email().max(254).transform(v => v.toLowerCase());
export const password = z.string().min(12).max(128);
export const role = z.enum(['owner', 'admin', 'catalogue_manager', 'analyst']);
export const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const acceptInvitation = z.object({ token, name: z.string().trim().min(1).max(100), password }).strict();
export const login = z.object({ email, password: z.string().min(1).max(128) }).strict();
export const forgotPassword = z.object({ email }).strict();
export const resetPassword = z.object({ token, password }).strict();
export const mfaSetup = z.object({ password: z.string().min(1).max(128) }).strict();
export const mfaVerify = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const mfaRecovery = z.object({ code: token }).strict();
export const inviteMember = z.object({ email, role }).strict();
export const changeRole = z.object({ role }).strict();

