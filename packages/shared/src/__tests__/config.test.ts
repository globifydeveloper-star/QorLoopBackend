import { describe, expect, it } from '@jest/globals';
import { loadConfig } from '../config.js';

const valid = { DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_SECRET: 'test-only-secret-at-least-thirty-two-characters' };
describe('environment validation', () => {
  it('rejects missing secrets without printing credentials', () => {
    expect(() => loadConfig({ DATABASE_URL: valid.DATABASE_URL, AUTH_SECRET: 'SECRET' })).toThrow('AUTH_SECRET');
    try { loadConfig({ DATABASE_URL: 'private-database-password', AUTH_SECRET: valid.AUTH_SECRET }); }
    catch (error) { expect(String(error)).not.toContain('private-database-password'); }
  });
  it('requires HTTPS, a generated secret and a tenant pin for production', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow();
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production', AUTH_SECRET: 'a'.repeat(48), APP_ORIGIN: 'https://store.example' })).toThrow('TENANT_ID');
    expect(loadConfig({ ...valid, NODE_ENV: 'production', AUTH_SECRET: 'a'.repeat(48), APP_ORIGIN: 'https://store.example', TENANT_ID: '00000000-0000-4000-8000-000000000001' }).NODE_ENV).toBe('production');
  });
  it('defaults upload concurrency to 1 and only accepts 1-4', () => {
    expect(loadConfig(valid).UPLOAD_CONCURRENCY).toBe(1);
    expect(loadConfig({ ...valid, UPLOAD_CONCURRENCY: '4' }).UPLOAD_CONCURRENCY).toBe(4);
    for (const bad of ['0', '5', '1.5', 'two']) expect(() => loadConfig({ ...valid, UPLOAD_CONCURRENCY: bad })).toThrow('UPLOAD_CONCURRENCY');
  });
});

