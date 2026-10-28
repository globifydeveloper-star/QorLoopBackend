import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/qorloop_dev'),
  TENANT_ID: z.string().uuid().default('00000000-0000-0000-0000-000000000001'),
  AUTH_SECRET: z.string().min(16).default('super-secret-development-key-32-chars-long'),
  STORAGE_DIR: z.string().default('./storage'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  BASE_DOMAIN: z.string().default('qorloop.globify.ae')
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
