import { describe, expect, it } from '@jest/globals';
import { loadConfig } from '../config.js';

const valid = { DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_SECRET: 'test-only-secret-at-least-thirty-two-characters' };
describe('environment validation', () => {
  it('rejects missing secrets without printing credentials', () => {
    expect(() => loadConfig({ DATABASE_URL: valid.DATABASE_URL, AUTH_SECRET: 'SECRET' })).toThrow('AUTH_SECRET');
    try { loadConfig({ DATABASE_URL: 'private-database-password', AUTH_SECRET: valid.AUTH_SECRET }); }
    catch (error) { expect(String(error)).not.toContain('private-database-password'); }
  });
  it('requires HTTPS, a generated secret, a real mail service and a tenant pin for production', () => {
    const mail = { SMTP_HOST: 'smtp.mail-provider.test', SMTP_PORT: '587', SMTP_USER: 'apikey', SMTP_PASSWORD: 'smtp-password-value' };
    const prod = { ...valid, ...mail, NODE_ENV: 'production', AUTH_SECRET: 'a'.repeat(48), APP_ORIGIN: 'https://store.example' };
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow();
    expect(() => loadConfig(prod)).toThrow('TENANT_ID');
    const pinned = { ...prod, TENANT_ID: '00000000-0000-4000-8000-000000000001' };
    expect(loadConfig(pinned).NODE_ENV).toBe('production');
    for (const host of ['localhost', '127.0.0.1', 'mailpit']) expect(() => loadConfig({ ...pinned, SMTP_HOST: host })).toThrow('SMTP_HOST');
    expect(() => loadConfig({ ...pinned, SMTP_USER: undefined })).toThrow('SMTP_USER');
    expect(() => loadConfig({ ...pinned, SMTP_PASSWORD: undefined })).toThrow('SMTP_USER');
    try { loadConfig({ ...pinned, SMTP_HOST: 'localhost' }); } catch (error) { expect(String(error)).not.toContain('smtp-password-value'); }
  });
  it('caps sessions at the owner-approved 20 days and 7 days idle', () => {
    expect(loadConfig(valid)).toMatchObject({ SESSION_MAX_DAYS: 20, SESSION_IDLE_DAYS: 7, MAIL_FROM_NAME: 'Qorloop' });
    expect(loadConfig({ ...valid, SESSION_MAX_DAYS: '2', SESSION_IDLE_DAYS: '1' })).toMatchObject({ SESSION_MAX_DAYS: 2, SESSION_IDLE_DAYS: 1 });
    expect(() => loadConfig({ ...valid, SESSION_MAX_DAYS: '21' })).toThrow('SESSION_MAX_DAYS');
    expect(() => loadConfig({ ...valid, SESSION_IDLE_DAYS: '8' })).toThrow('SESSION_IDLE_DAYS');
    expect(loadConfig({ ...valid, SMTP_SECURE: 'true' }).SMTP_SECURE).toBe(true);
    expect(loadConfig(valid).SMTP_SECURE).toBeUndefined();
    expect(() => loadConfig({ ...valid, MAIL_FROM_NAME: 'Bad <name>' })).toThrow('MAIL_FROM_NAME');
  });
  it('defaults upload concurrency to 1 and only accepts 1-4', () => {
    expect(loadConfig(valid).UPLOAD_CONCURRENCY).toBe(1);
    expect(loadConfig({ ...valid, UPLOAD_CONCURRENCY: '4' }).UPLOAD_CONCURRENCY).toBe(4);
    for (const bad of ['0', '5', '1.5', 'two']) expect(() => loadConfig({ ...valid, UPLOAD_CONCURRENCY: bad })).toThrow('UPLOAD_CONCURRENCY');
  });
});

