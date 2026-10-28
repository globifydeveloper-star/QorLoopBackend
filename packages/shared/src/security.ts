import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import Iron from '@hapi/iron';

export const opaqueToken = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function matchesDigest(value: string, expected: string): boolean {
  const actual = Buffer.from(digest(value), 'hex');
  const target = Buffer.from(expected, 'hex');
  return actual.length === target.length && timingSafeEqual(actual, target);
}
export const hashPassword = (password: string) => hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (password: string, passwordHash: string) => verify(passwordHash, password);
export const seal = (value: unknown, secret: string) => Iron.seal(value, secret, { ...Iron.defaults, ttl: 0 });
export const unseal = <T>(value: string, secret: string): Promise<T> => Iron.unseal(value, secret, { ...Iron.defaults, ttl: 0 });
