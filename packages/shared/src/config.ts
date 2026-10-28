import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url().refine(v => /^postgres(ql)?:/.test(v)),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  AUTH_SECRET: z.string().min(32),
  BASE_DOMAIN: z.string().default('qorloop.globify.ae'),
  TENANT_ID: z.string().uuid().optional(),
  APP_ORIGIN: z.string().url().default('http://dohafresh.localhost:3000'),
  CORS_ORIGIN: z.string().url().optional(),
  SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().email().default('noreply@qorloop.globify.ae'),
  SENTRY_DSN: z.string().url().optional(),
}).superRefine((v, ctx) => {
  if (v.NODE_ENV === 'production') {
    if (!v.APP_ORIGIN.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'HTTPS required' });
    if (/development|super-secret|change.me|example/i.test(v.AUTH_SECRET)) ctx.addIssue({ code: 'custom', path: ['AUTH_SECRET'], message: 'Use a generated production secret' });
  }
  for (const origin of [v.APP_ORIGIN, v.CORS_ORIGIN].filter(Boolean) as string[]) {
    const u = new URL(origin);
    if (u.origin !== origin || !['http:', 'https:'].includes(u.protocol)) ctx.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'Use an exact HTTP(S) origin without a trailing slash' });
  }
});
export type Config = z.infer<typeof schema>;
export function loadConfig(input: NodeJS.ProcessEnv = process.env, options: { requireTenantPin?: boolean } = {}): Config {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`Invalid environment: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (result.data.NODE_ENV === 'production' && options.requireTenantPin !== false && !result.data.TENANT_ID) throw new Error('Invalid environment: TENANT_ID must pin the isolated production instance');
  return result.data;
}
