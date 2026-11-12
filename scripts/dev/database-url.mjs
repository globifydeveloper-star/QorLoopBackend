// Shared by the Node dev scripts: reads values from a .env file the way the app does (dotenv) and splits DATABASE_URL
// WITHOUT a URL parser. A password may contain '@' and ':', so the credentials end at the LAST '@' (the same rule as
// database-url.ps1 and change-db-password.mjs):
//   postgres[ql]://user[:password]@host[:port][/database][?sslmode=...]
// Percent-escapes in user, password and database are decoded, as node-pg (and so the app) does.
// Nothing here prints anything. Every failure is an EnvError with a fixed message: never the value, never a driver text.
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';

export class EnvError extends Error {}
const fail = message => { throw new EnvError(message); };

const decode = s => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, run => { try { return decodeURIComponent(run); } catch { return run; } });

/** user, password, host, port, database and sslmode of a postgres URL; the credentials end at the LAST '@'. */
export function splitDatabaseUrl(url) {
  const m = /^postgres(?:ql)?:\/\/([\s\S]*)$/.exec(url ?? '');
  if (!m) fail('DATABASE_URL is not a postgres:// or postgresql:// URL');
  const rest = m[1];
  const at = rest.lastIndexOf('@');
  if (at < 1) fail('DATABASE_URL has no user@host part');
  const userInfo = rest.slice(0, at);
  const loc = /^(\[[^\]]+\]|[^:/?#[\]]+)(?::(\d{1,5}))?(?:\/([^?#]*))?(?:\?([^#]*))?$/.exec(rest.slice(at + 1));
  const colon = userInfo.indexOf(':');
  const user = decode(colon < 0 ? userInfo : userInfo.slice(0, colon));
  if (!user || !loc) fail('DATABASE_URL is not of the form postgresql://user:password@host:port/database');
  let sslMode = null;
  for (const pair of (loc[4] ?? '').split('&')) {
    const [k, v] = pair.split('=', 2);
    if (k === 'sslmode' && v) sslMode = decode(v);
  }
  return {
    user, password: colon < 0 ? '' : decode(userInfo.slice(colon + 1)),
    host: loc[1].replace(/^\[|\]$/g, ''), port: loc[2] ? Number(loc[2]) : 5432, database: decode(loc[3] ?? '') || user, sslMode,
  };
}

/** node-pg client options for the split URL. libpq's sslmode: disable/allow/prefer = no TLS, require = TLS without
 * certificate checks, verify-ca/verify-full = TLS with checks. */
export function pgClientOptions(parts, applicationName) {
  const mode = parts.sslMode ?? 'disable';
  if (!['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(mode)) fail('DATABASE_URL has an unknown sslmode');
  const ssl = mode === 'require' ? { rejectUnauthorized: false } : mode.startsWith('verify-') ? { rejectUnauthorized: true } : false;
  return {
    host: parts.host, port: parts.port, user: parts.user, password: parts.password, database: parts.database, ssl,
    application_name: applicationName, connectionTimeoutMillis: 10_000,
  };
}

/** The values of a .env file as dotenv reads them. DATABASE_URL must be on exactly one line. */
export function readEnvFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { fail('cannot read the env file'); }
  const lines = text.split(/\r?\n/).filter(l => /^\s*(?:export\s+)?DATABASE_URL\s*[=:]/.test(l)).length;
  if (lines !== 1) fail(`the env file must have exactly one DATABASE_URL line (found ${lines})`);
  const values = dotenv.parse(text);
  text = null;
  if (!values.DATABASE_URL) fail('DATABASE_URL is empty in the env file');
  return values;
}

const SAFE_CODES = {
  '28P01': 'password authentication failed', '28000': 'connection not allowed (pg_hba.conf)', '3D000': 'database does not exist',
  '42501': 'permission denied', '55P03': 'lock not available (lock_timeout)', '57014': 'statement cancelled (timeout)',
  '23503': 'foreign key violation', '40001': 'serialization failure', '57P03': 'server is starting up or shutting down',
  '53300': 'too many connections', ECONNREFUSED: 'connection refused', ECONNRESET: 'connection reset', ETIMEDOUT: 'timed out',
  ENOTFOUND: 'host not found', EACCES: 'access denied', ENOENT: 'not found',
};
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
/** A fixed description of an error: its code (and, for SQL errors, the table and constraint names), never its message. */
export function describeError(e) {
  if (e instanceof EnvError || (e && e.name === 'ResetRefused')) return e.message;
  const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
  if (!code) return e instanceof Error && /timeout/i.test(e.message) ? 'connection timed out' : 'unexpected error (details withheld)';
  const where = [e.table, e.constraint].filter(v => typeof v === 'string' && IDENT.test(v));
  return `${code}${SAFE_CODES[code] ? ` (${SAFE_CODES[code]})` : ''}${where.length ? ` on ${where.join(' / ')}` : ''}`;
}
