import { HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ReadinessUnavailable } from './readiness.js';

const codes: Record<number, string> = { 400: 'VALIDATION_ERROR', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMITED', 503: 'UNAVAILABLE' };
/** Codes a client acts on (ADR 021). Any other code is replaced by the generic one for its status. */
const sessionCodes: Record<string, number> = {
  UNAUTHENTICATED: 401, SESSION_EXPIRED: 401, CSRF_REQUIRED: 403,
  AUTHENTICATOR_SETUP_REQUIRED: 403, STEP_UP_REQUIRED: 403,
  CHALLENGE_EXPIRED: 401, OTP_INVALID: 401, OTP_LOCKED: 401, OTP_SEND_LIMIT: 429,
};

/** Shared by Nest routes and Fastify parser/framework errors. No raw exception messages on unexpected errors. */
export function sendError(error: unknown, req: FastifyRequest, reply: FastifyReply, reportErrors = false) {
  if (reply.sent) return;
  const plain = error as { statusCode?: unknown; error?: { message?: string } } | null;
  const plainStatus = typeof plain?.statusCode === 'number' && plain.statusCode >= 400 && plain.statusCode < 500 ? plain.statusCode : undefined;
  const status = error instanceof HttpException ? error.getStatus() : plainStatus ?? 500;
  const response = error instanceof HttpException ? error.getResponse() : plainStatus ? { message: plain?.error?.message } : undefined;
  const detail = typeof response === 'object' && response !== null ? response as { code?: string; message?: string | string[]; details?: unknown; meta?: Record<string, unknown> } : {};
  const message = status >= 500 ? (status === 503 ? 'Service unavailable' : 'Internal server error')
    : typeof response === 'string' ? response : detail.message ?? 'Request failed';
  if (status >= 500) {
    req.log.error({ requestId: req.id, errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    if (reportErrors) void import('@sentry/node').then(Sentry => Sentry.captureException(new Error('Unhandled application error'),
      { tags: { requestId: req.id, errorType: error instanceof Error ? error.name : 'UnknownError' } })).catch(() => undefined);
  }
  const code = detail.code && sessionCodes[detail.code] === status ? detail.code : codes[status] ?? 'INTERNAL_ERROR';
  const details = error instanceof ReadinessUnavailable
    ? Object.entries(error.components).map(([path, state]) => ({ path, message: state }))
    : status < 500 ? detail.details : undefined;
  // meta: small, fixed fields of an actionable code only (attemptsLeft, window, retryAfterSeconds); never free text.
  const meta = status < 500 && detail.code && code === detail.code && detail.meta ? detail.meta : undefined;
  reply.header('X-Request-ID', req.id).code(status).send({ error: { code, message, ...(details ? { details } : {}), ...(meta ? { meta } : {}) }, requestId: req.id });
}
