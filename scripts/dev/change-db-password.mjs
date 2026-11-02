#!/usr/bin/env node
// Rotates the PostgreSQL password of the role named in DATABASE_URL (development; you run it, from the repository):
//   node scripts/dev/change-db-password.mjs --self-test   offline checks only: no file is read, no database is touched
//   node scripts/dev/change-db-password.mjs               rotate
// Options: --env-file <path> (default: this repository's .env), --backup-env-file <path> (default
// D:\Secrets\qorloop\env.backup), --skip-backup-env-file (only when that copy does not exist).
//
// Nothing secret is printed: not the URL, not either password, not file contents, not raw error messages (only error
// codes such as SQLSTATE 28P01). Steps, in order; a failure stops there and names the step:
//   1 read .env              exactly one DATABASE_URL, read the way the app reads it (dotenv, then node-pg)
//   2 read env.backup        same role, host, port and database as .env
//   3 connect                the current password works, as the role in the URL, and the server really checks passwords
//   4 back up files          <file>.bak-<timestamp> copies of both files
//   5 prepare files          <file>.tmp-<timestamp>: only the password inside DATABASE_URL replaced, re-read and checked
//   6 ALTER ROLE             a new 24-character password (letters and digits), sent as a SCRAM-SHA-256 verifier
//   7 verify new password    a new connection with the new URL
//   8 write files            env.backup, then .env, replaced by the prepared files
//   9 verify .env            .env re-read from disk connects
// Steps 1-5 change nothing but the backup copies. From step 6 on, a failure puts the old password back on the role
// (through the session still open from step 3) and restores the files already written, so .env keeps matching the
// database; when even that fails, the script says exactly what to do and keeps the file that holds the new password.
import { constants, copyFileSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import pg from 'pg';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PASSWORD_LENGTH = 24;
const CONNECT_TIMEOUT_MS = 10_000;

class StepError extends Error {}
const fail = message => { throw new StepError(message); };

const SAFE_CODES = {
  '28P01': 'password authentication failed', '28000': 'connection not allowed (pg_hba.conf)', '3D000': 'database does not exist',
  '42501': 'not allowed to change this role', '57P03': 'server is starting up or shutting down', '53300': 'too many connections',
  ECONNREFUSED: 'connection refused', ECONNRESET: 'connection reset', ETIMEDOUT: 'timed out', ENOTFOUND: 'host not found',
  EPERM: 'not permitted (file locked or read-only?)', EBUSY: 'file in use', EACCES: 'access denied', ENOENT: 'not found', EEXIST: 'already exists',
};
/** A fixed description of an error: its code, never its message (a driver or system message could carry a value). */
function describe(e) {
  if (e instanceof StepError) return e.message;
  const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
  if (code) return `${code}${SAFE_CODES[code] ? ` (${SAFE_CODES[code]})` : ''}`;
  if (e instanceof Error && /timeout/i.test(e.message)) return 'connection timed out';
  return 'unexpected error (details withheld)';
}

// ───────── Reading DATABASE_URL ─────────

const decode = s => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, run => { try { return decodeURIComponent(run); } catch { return run; } });

/** postgres[ql]://user[:password]@host[:port][/database][?query]; the credentials end at the LAST '@'. */
export function splitUrl(url) {
  const m = /^(postgres(?:ql)?:\/\/)([\s\S]*)$/.exec(url);
  if (!m) fail('DATABASE_URL is not a postgres:// or postgresql:// URL');
  const [, scheme, rest] = m;
  const at = rest.lastIndexOf('@');
  if (at < 1) fail('DATABASE_URL has no user@host part');
  const userInfo = rest.slice(0, at);
  const location = rest.slice(at + 1);
  const colon = userInfo.indexOf(':');
  const userRaw = colon < 0 ? userInfo : userInfo.slice(0, colon);
  const loc = /^(\[[^\]]+\]|[^:/?#[\]]+)(?::(\d{1,5}))?(?:\/([^?#]*))?(?:\?([^#]*))?$/.exec(location);
  if (!userRaw || !loc) fail('DATABASE_URL is not of the form postgresql://user:password@host:port/database');
  const user = decode(userRaw);
  return {
    user, password: colon < 0 ? '' : decode(userInfo.slice(colon + 1)),
    host: loc[1].replace(/^\[|\]$/g, ''), port: loc[2] ? Number(loc[2]) : 5432, database: decode(loc[3] ?? '') || user,
    /** The same URL with only the password replaced; everything else stays byte for byte. */
    withPassword: password => `${scheme}${userRaw}:${password}@${location}`,
  };
}

/** What node-pg, and so the app (Prisma's adapter-pg hands it the URL), reads from a URL. Never connects. */
function pgView(url) {
  let c;
  try { c = new pg.Client({ connectionString: url }); } catch { fail('node-pg cannot read this DATABASE_URL (the app could not either)'); }
  return { user: c.user, password: c.password, host: String(c.host).replace(/^\[|\]$/g, ''), port: Number(c.port), database: c.database };
}
const sameFields = (a, b, keys) => keys.every(k => String(a[k]) === String(b[k]));
const LOCATION = ['user', 'host', 'port', 'database'];

/** The file, its one DATABASE_URL line and the value exactly as dotenv reads it (the app loads .env with dotenv). */
export function readEnvText(text, label) {
  const parts = text.split(/(\r?\n)/); // line separators kept at the odd indexes
  const hits = [];
  for (let i = 0; i < parts.length; i += 2) if (/^\s*(?:export\s+)?DATABASE_URL\s*[=:]/.test(parts[i])) hits.push(i);
  if (hits.length !== 1) fail(`${label} must have exactly one DATABASE_URL line (found ${hits.length})`);
  const line = parts[hits[0]];
  const value = dotenv.parse(line).DATABASE_URL;
  if (!value) fail(`${label}: DATABASE_URL is empty`);
  const all = dotenv.parse(text);
  if (all.DATABASE_URL !== value) fail(`${label}: DATABASE_URL reads differently in the whole file; not changing it`);
  const at = line.indexOf(value, line.search(/[=:]/) + 1);
  if (at < 0) fail(`${label}: DATABASE_URL is written in a form this script cannot rewrite (escape sequences?)`);
  return { label, text, parts, line: hits[0], value, at, all };
}
function readEnvFile(path, label) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { fail(`cannot read ${label}: ${describe(e)}`); }
  return { ...readEnvText(text, label), path };
}

/** The file with only the password inside DATABASE_URL replaced, proven by reading it back like the app will. */
export function rewriteText(file, newPassword) {
  const parts = [...file.parts];
  const line = parts[file.line];
  parts[file.line] = line.slice(0, file.at) + splitUrl(file.value).withPassword(newPassword) + line.slice(file.at + file.value.length);
  const text = parts.join('');
  const all = dotenv.parse(text);
  for (const k of new Set([...Object.keys(file.all), ...Object.keys(all)])) {
    if (k !== 'DATABASE_URL' && all[k] !== file.all[k]) fail(`${file.label}: rewriting would change ${k}; not changing anything`);
  }
  const before = pgView(file.value), after = pgView(all.DATABASE_URL);
  if (after.password !== newPassword || !sameFields(before, after, LOCATION)) fail(`${file.label}: the rewritten DATABASE_URL does not read back as intended`);
  return { text, url: all.DATABASE_URL };
}

// ───────── Passwords ─────────

export const randomPassword = () => Array.from({ length: PASSWORD_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const hmac = (key, text) => createHmac('sha256', key).update(text).digest();

/**
 * PostgreSQL's stored form of a password, SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>, so the plaintext
 * never reaches the server (or its log). Letters and digits only: SASLprep leaves them unchanged.
 */
export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  if (!/^[A-Za-z0-9]+$/.test(password)) fail('internal: a verifier is only computed for letters and digits');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** ALTER ROLE <current_user> PASSWORD ..., quoted by the server (format %I %L). `plaintext` only to put an old password back. */
async function setRolePassword(client, password, { plaintext = false } = {}) {
  const value = plaintext ? password : scramVerifier(password);
  const { rows: [r] } = await client.query("SELECT format('ALTER ROLE %I PASSWORD %L', current_user, $1::text) AS sql", [value]);
  await client.query(r.sql);
}

async function connect(url) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, application_name: 'qorloop-change-db-password' });
  c.on('error', () => {}); // a session dropped while idle surfaces on its next query
  try { await c.connect(); } catch (e) { await c.end().catch(() => {}); throw e; }
  return c;
}
async function roleOf(url) {
  const c = await connect(url);
  try { return (await c.query('SELECT current_user AS role')).rows[0].role; } finally { await c.end().catch(() => {}); }
}

// ───────── Files ─────────

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function backupCopy(path, suffix) {
  const bak = `${path}.bak-${suffix}`;
  copyFileSync(path, bak, constants.COPYFILE_EXCL);
  if (!readFileSync(bak).equals(readFileSync(path))) fail(`the backup of ${basename(path)} does not match it`);
  return bak;
}
function replaceFile(tmp, path) {
  try { renameSync(tmp, path); } catch {
    writeFileSync(path, readFileSync(tmp)); // the target is open elsewhere: overwrite in place instead
    rmSync(tmp, { force: true });
  }
}

/** Files under `roots` that contain `needle` (names only), skipping dependencies, build output and `except`. */
function filesContaining(needle, roots, except) {
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage', 'storage']);
  const found = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p); continue; }
      if (!e.isFile() || except.has(resolve(p))) continue;
      try { if (statSync(p).size <= 5_000_000 && readFileSync(p).includes(needle)) found.push(p); } catch { /* unreadable: skip */ }
    }
  };
  for (const r of roots) walk(r);
  return found;
}

// ───────── Rotation ─────────

async function rotate({ envFile, backupEnvFile }) {
  const suffix = stamp();
  const s = { step: '', session: null, altered: false, written: [], tmps: [], baks: new Map(), oldPassword: null, newUrl: null };
  const step = async (name, fn) => { s.step = name; console.log(`[${name}]`); return fn(); };
  try {
    const env = await step('1 read .env', () => {
      const f = readEnvFile(envFile, '.env');
      const mine = splitUrl(f.value), app = pgView(f.value);
      if (!sameFields(mine, app, [...LOCATION, 'password'])) fail('this script and node-pg read DATABASE_URL differently; not changing anything');
      return f;
    });
    const app = pgView(env.value);
    s.oldPassword = app.password;
    const copy = backupEnvFile ? await step('2 read env.backup', () => {
      try { statSync(backupEnvFile); } catch { fail(`${backupEnvFile} not found: create it, pass --backup-env-file <path>, or --skip-backup-env-file`); }
      const f = readEnvFile(backupEnvFile, 'env.backup');
      if (!sameFields(pgView(f.value), app, LOCATION)) fail('env.backup names another role, host, port or database than .env; not changing anything');
      return f;
    }) : null;
    if (!copy) console.log('[2 read env.backup] skipped (--skip-backup-env-file)');

    s.session = await step('3 connect with the current password', async () => {
      const session = await connect(env.value);
      const role = (await session.query('SELECT current_user AS role')).rows[0].role;
      if (role !== app.user) { await session.end(); fail('connected as another role than DATABASE_URL names'); }
      // A server that accepts any password (pg_hba.conf trust) cannot prove the new one works: refuse before changing it.
      try { await roleOf(splitUrl(env.value).withPassword(randomPassword())); } catch (e) {
        if (e && e.code === '28P01') return session;
        await session.end(); fail(`checking that the server verifies passwords failed: ${describe(e)}`);
      }
      await session.end();
      fail('the server accepts any password on this connection (pg_hba.conf trust), so a new password could not be verified; nothing changed');
    });

    const files = [env, copy].filter(Boolean);
    await step('4 back up files', () => { for (const f of files) s.baks.set(f.path, backupCopy(f.path, suffix)); });

    const newPassword = randomPassword();
    const prepared = await step('5 prepare files', () => files.map(f => {
      const { text, url } = rewriteText(f, newPassword);
      const tmp = `${f.path}.tmp-${suffix}`;
      writeFileSync(tmp, text, { flag: 'wx' });
      s.tmps.push(tmp);
      if (readFileSync(tmp, 'utf8') !== text) fail(`the prepared ${f.label} does not read back`);
      return { file: f, tmp, url };
    }));
    s.newUrl = prepared[0].url;

    await step('6 ALTER ROLE', async () => { s.altered = true; await setRolePassword(s.session, newPassword); });
    await step('7 verify the new password', async () => {
      if ((await roleOf(s.newUrl)) !== app.user) fail('the new password connects as another role');
    });
    await step('8 write files', () => {
      for (const p of [...prepared].reverse()) { replaceFile(p.tmp, p.file.path); s.written.push(p.file.path); s.tmps = s.tmps.filter(t => t !== p.tmp); }
    });
    await step('9 verify .env from disk', async () => {
      const f = readEnvFile(envFile, '.env');
      if (pgView(f.value).password !== newPassword) fail('.env does not hold the new password after writing');
      if ((await roleOf(f.value)) !== app.user) fail('.env from disk connects as another role');
    });
    await s.session.end().catch(() => {});

    console.log('\nDone: the role has a new password; DATABASE_URL updated in:');
    for (const f of files) console.log(`  ${f.path}  (previous version: ${basename(s.baks.get(f.path))}, holds the old password)`);
    const others = filesContaining(`:${app.password}@`, [REPO, ...(copy ? [dirname(copy.path)] : [])],
      new Set([...files.map(f => resolve(f.path)), ...[...s.baks.values()].map(b => resolve(b))]));
    console.log(others.length ? '\nOther files that still contain the old password in a URL (names only):' : '\nNo other file under the repository contains the old password in a URL.');
    for (const p of others) console.log(`  ${relative(REPO, p).startsWith('..') ? p : relative(REPO, p)}`);
    console.log('\nRestart now (they keep the old URL in memory; new database connections fail until then): the API and the worker.');
    return 0;
  } catch (e) {
    console.error(`\nFAILED at step "${s.step}": ${describe(e)}`);
    return s.altered ? recover(s) : abandon(s);
  }
}

/** Before ALTER ROLE: nothing to undo but the prepared files. .env and the role are unchanged. */
async function abandon(s) {
  for (const t of s.tmps) rmSync(t, { force: true });
  await s.session?.end().catch(() => {});
  console.error('Nothing was changed: the role keeps its password and .env is unchanged.');
  if (s.baks.size) console.error(`Backup copies made in step 4 (safe to delete): ${[...s.baks.values()].map(b => basename(b)).join(', ')}`);
  return 1;
}

/**
 * After ALTER ROLE: the old password back on the role through the session opened in step 3, then the files already
 * written back from their backups. If the role cannot be set back, the files are left matching the role instead.
 */
async function recover(s) {
  let roleOk = false;
  try {
    // plaintext so the server applies its own SASLprep to whatever the old password contains
    await setRolePassword(s.session, s.oldPassword, { plaintext: true });
    roleOk = true;
  } catch { /* reported below */ }
  await s.session?.end().catch(() => {});
  if (roleOk) {
    let filesOk = true;
    for (const path of s.written) {
      try { copyFileSync(s.baks.get(path), path); } catch { filesOk = false; console.error(`  could not restore ${basename(path)}: copy ${basename(s.baks.get(path))} over it`); }
    }
    for (const t of s.tmps) rmSync(t, { force: true });
    console.error(filesOk ? 'Recovered: the old password is back on the role and .env is unchanged.'
      : 'The old password is back on the role, but a file could not be restored: copy its backup over it as shown above.');
    return filesOk ? 1 : 2;
  }
  // The role may now have the NEW password. Leave the files that match it; the prepared ones hold the new URL.
  const newWorks = s.newUrl ? await roleOf(s.newUrl).then(() => true, () => false) : false;
  if (newWorks) {
    console.error('The role now has the NEW password and the old one could not be set back.'
      + (s.written.length ? ` Already updated: ${s.written.map(p => basename(p)).join(', ')}.` : '')
      + (s.tmps.length ? ` To finish, copy each prepared file over its target: ${s.tmps.map(t => basename(t)).join(', ')}.` : ''));
  } else {
    console.error('The old password could not be set back and the new one does not connect either: set the role password with psql as a superuser, then put it in DATABASE_URL in .env.');
  }
  return 2;
}

// ───────── Offline self-test (no file is read, no database is touched) ─────────

async function selfTest() {
  const sasl = createRequire(import.meta.url)('pg/lib/crypto/sasl.js');
  const check = (ok, what) => { if (!ok) throw new Error(`self-test failed: ${what}`); console.log(`ok  ${what}`); };

  // 1. The verifier authenticates node-pg's own SCRAM client, with this script playing the server's part.
  const password = randomPassword();
  check(password.length === 24 && /^[A-Za-z0-9]+$/.test(password), 'random password: 24 letters and digits');
  const [, iterations, salt, storedKey, serverKey] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(scramVerifier(password));
  const session = sasl.startSession(['SCRAM-SHA-256']);
  const nonce = session.clientNonce + randomBytes(12).toString('base64');
  const serverFirst = `r=${nonce},s=${salt},i=${iterations}`;
  await sasl.continueSession(session, password, serverFirst);
  const finalWithoutProof = session.response.replace(/,p=[^,]+$/, '');
  const proof = Buffer.from(/,p=([^,]+)$/.exec(session.response)[1], 'base64');
  // RFC 5802: client-first-message-bare, server-first-message, client-final-message-without-proof
  const authMessage = `n=*,r=${session.clientNonce},${serverFirst},${finalWithoutProof}`;
  const clientSignature = hmac(Buffer.from(storedKey, 'base64'), authMessage);
  const clientKey = Buffer.from(proof.map((b, i) => b ^ clientSignature[i]));
  check(createHash('sha256').update(clientKey).digest('base64') === storedKey, 'SCRAM: the client proof matches StoredKey (what the server checks)');
  sasl.finalizeSession(session, `v=${hmac(Buffer.from(serverKey, 'base64'), authMessage).toString('base64')}`);
  check(true, 'SCRAM: node-pg accepts the server signature from ServerKey');
  const wrong = sasl.startSession(['SCRAM-SHA-256']);
  await sasl.continueSession(wrong, randomPassword(), `r=${wrong.clientNonce}x,s=${salt},i=${iterations}`);
  const wrongProof = Buffer.from(/,p=([^,]+)$/.exec(wrong.response)[1], 'base64');
  const wrongAuth = `n=*,r=${wrong.clientNonce},r=${wrong.clientNonce}x,s=${salt},i=${iterations},${wrong.response.replace(/,p=[^,]+$/, '')}`;
  const wrongKey = Buffer.from(wrongProof.map((b, i) => b ^ hmac(Buffer.from(storedKey, 'base64'), wrongAuth)[i]));
  check(createHash('sha256').update(wrongKey).digest('base64') !== storedKey, 'SCRAM: another password is refused');

  // 2. URLs: the last '@' ends the credentials, exactly as node-pg reads them.
  const cases = [
    ['postgresql://app:p@ss:w0rd@localhost:5432/qorloop?schema=public', { user: 'app', password: 'p@ss:w0rd', host: 'localhost', port: 5432, database: 'qorloop' }],
    ['postgres://app:p%40ss@127.0.0.1/qorloop', { user: 'app', password: 'p@ss', host: '127.0.0.1', port: 5432, database: 'qorloop' }],
    ['postgresql://app:a@b@c@db.internal:6543/x', { user: 'app', password: 'a@b@c', host: 'db.internal', port: 6543, database: 'x' }],
  ];
  cases.forEach(([url, want], i) => {
    const mine = splitUrl(url);
    check(sameFields(mine, want, [...LOCATION, 'password']) && sameFields(mine, pgView(url), [...LOCATION, 'password']), `URL ${i + 1}: split on the last '@', same as node-pg`);
  });
  check(splitUrl('postgresql://app:old@x@h:1/d?sslmode=disable').withPassword('N3w') === 'postgresql://app:N3w@h:1/d?sslmode=disable', 'URL: only the password is replaced');

  // 3. A .env rewrite changes the password and nothing else (BOM, CRLF, quotes, comments and other keys kept).
  const sample = '\uFEFF# local\r\nPORT=4000\r\nDATABASE_URL="postgresql://app:o@ld@localhost:5432/qorloop" # main db\r\nREDIS_URL=redis://localhost:6379\r\n';
  const file = readEnvText(sample, 'sample');
  const { text } = rewriteText(file, 'Zz9');
  check(text === sample.replace('o@ld', 'Zz9'), '.env rewrite: only the password changes, byte for byte');
  let refused = false;
  try { readEnvText('DATABASE_URL=postgresql://a:b@h/d\nDATABASE_URL=postgresql://a:c@h/d\n', 'sample'); } catch (e) { refused = e instanceof StepError; }
  check(refused, '.env with two DATABASE_URL lines is refused');
  console.log('\nSelf-test passed (nothing was read from disk and no database was contacted).');
  return 0;
}

// ───────── Entry ─────────

const { values } = parseArgs({
  options: {
    'self-test': { type: 'boolean', default: false },
    'env-file': { type: 'string', default: join(REPO, '.env') },
    'backup-env-file': { type: 'string', default: 'D:\\Secrets\\qorloop\\env.backup' },
    'skip-backup-env-file': { type: 'boolean', default: false },
  },
  strict: true,
});
const main = values['self-test'] ? selfTest()
  : rotate({ envFile: resolve(values['env-file']), backupEnvFile: values['skip-backup-env-file'] ? null : resolve(values['backup-env-file']) });
process.exitCode = await main.catch(e => { console.error(`FAILED: ${describe(e)}${e instanceof Error && e.message.startsWith('self-test') ? ` - ${e.message}` : ''}`); return 1; });
