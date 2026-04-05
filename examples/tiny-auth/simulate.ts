#!/usr/bin/env -S deno run --allow-all
/**
 * Tiny Auth — Simulation Mode
 *
 * Simulates realistic auth usage: admin bootstraps the system, creates
 * invites, users register and log in, sessions expire, profiles are
 * checked. Data stored as pretty-printed JSON files for easy inspection.
 *
 * Storage: local-json (one .json file per item, human-readable)
 *
 * Run:
 *   deno task auth:sim           # simulate usage
 *   deno task auth:sim --clean   # wipe and re-simulate
 */

import { join } from 'https://deno.land/std@0.224.0/path/mod.ts';
import {
  createSmallstore,
  createMemoryAdapter,
  createLocalJsonAdapter,
} from '../../mod.ts';

// ============================================================================
// Config
// ============================================================================

const APP_DIR = import.meta.dirname!;
const DATA_DIR = join(APP_DIR, 'data');
const JSON_DIR = join(DATA_DIR, 'json');

if (Deno.args.includes('--clean')) {
  try { await Deno.remove(DATA_DIR, { recursive: true }); } catch { /* ok */ }
  console.log('Cleaned data directory.\n');
}
await Deno.mkdir(DATA_DIR, { recursive: true });

// ============================================================================
// Helpers
// ============================================================================

function ts(): string {
  return new Date().toISOString();
}

function expiresIn(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

function isExpired(isoDate: string): boolean {
  return new Date(isoDate).getTime() < Date.now();
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function unwrap(result: any): any {
  if (result === null || result === undefined) return null;
  if (result.content !== undefined) {
    const c = result.content;
    if (Array.isArray(c) && c.length === 1) return c[0];
    return c;
  }
  return result;
}

function log(icon: string, msg: string) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`  [${time}] ${icon} ${msg}`);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================================
// Password Hashing (Web Crypto)
// ============================================================================

async function hashPassword(password: string, salt?: string): Promise<string> {
  salt = salt || crypto.randomUUID().replace(/-/g, '');
  const data = new TextEncoder().encode(salt + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = [...new Uint8Array(hashBuffer)]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `${salt}:${hashHex}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt] = storedHash.split(':');
  const check = await hashPassword(password, salt);
  return check === storedHash;
}

function stripSensitive(user: any): any {
  if (!user) return user;
  const { passwordHash: _, ...safe } = user;
  return safe;
}

// ============================================================================
// Auth Functions (same as mod.ts — self-contained)
// ============================================================================

async function register(
  store: any,
  input: { email: string; password: string; name: string; inviteCode?: string },
) {
  const { email, password, name, inviteCode } = input;
  if (!email || !password) return { ok: false, error: 'email and password required' };

  const existing = await store.get(`auth/users/${email}`);
  if (existing !== null && unwrap(existing) !== null) {
    return { ok: false, error: 'email already registered' };
  }

  let role = 'user';
  if (inviteCode) {
    const invite = unwrap(await store.get(`auth/invites/${inviteCode}`));
    if (!invite) return { ok: false, error: 'invalid invite code' };
    if (invite.usedBy) return { ok: false, error: 'invite already used' };
    if (invite.expiresAt && isExpired(invite.expiresAt)) return { ok: false, error: 'invite expired' };
    role = invite.role || 'user';
    await store.patch(`auth/invites/${inviteCode}`, { usedBy: email, usedAt: ts() });
  }

  const passwordHash = await hashPassword(password);
  const user = { email, name, role, status: 'active', passwordHash, createdAt: ts(), lastLoginAt: null };
  await store.set(`auth/users/${email}`, user, { mode: 'replace' });
  return { ok: true, data: stripSensitive(user) };
}

async function login(
  store: any,
  input: { email: string; password: string; userAgent?: string; ip?: string },
) {
  const { email, password, userAgent, ip } = input;
  const user = unwrap(await store.get(`auth/users/${email}`));
  if (!user) return { ok: false, error: 'user not found' };
  if (user.status !== 'active') return { ok: false, error: 'account not active' };

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return { ok: false, error: 'invalid password' };

  const token = crypto.randomUUID();
  await store.set(`auth/sessions/${token}`, {
    token, email, expiresAt: expiresIn(24), createdAt: ts(),
    userAgent: userAgent || null, ip: ip || null,
  }, { mode: 'replace' });
  await store.patch(`auth/users/${email}`, { lastLoginAt: ts() });
  return { ok: true, data: { token, user: stripSensitive(user) } };
}

async function getProfile(store: any, token: string) {
  const session = unwrap(await store.get(`auth/sessions/${token}`));
  if (!session) return { ok: false, error: 'unauthorized' };
  if (isExpired(session.expiresAt)) {
    await store.delete(`auth/sessions/${token}`);
    return { ok: false, error: 'session expired' };
  }
  const user = unwrap(await store.get(`auth/users/${session.email}`));
  if (!user) return { ok: false, error: 'user not found' };
  return { ok: true, data: stripSensitive(user) };
}

async function createInvite(
  store: any,
  token: string,
  opts?: { email?: string; role?: string },
) {
  const profile = await getProfile(store, token);
  if (!profile.ok) return profile;
  if (profile.data.role !== 'admin') return { ok: false, error: 'admin only' };

  const code = crypto.randomUUID().slice(0, 8);
  const invite = {
    code, email: opts?.email || null, role: opts?.role || 'user',
    usedBy: null, usedAt: null, expiresAt: expiresIn(72), createdAt: ts(),
  };
  await store.set(`auth/invites/${code}`, invite, { mode: 'replace' });
  return { ok: true, data: invite };
}

// ============================================================================
// Magic Link Functions (passwordless login)
// ============================================================================

function expiresInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function sendMagicLink(store: any, email: string) {
  if (!email) return { ok: false, error: 'email required' };
  const token = crypto.randomUUID();
  await store.set(`auth/magic-links/${token}`, {
    token, email, expiresAt: expiresInMinutes(15), createdAt: ts(), usedAt: null,
  }, { mode: 'replace' });
  return { ok: true, data: { token, email } };
}

async function verifyMagicLink(
  store: any,
  token: string,
  opts?: { userAgent?: string; ip?: string },
) {
  const link = unwrap(await store.get(`auth/magic-links/${token}`));
  if (!link) return { ok: false, error: 'invalid magic link' };
  if (link.usedAt) return { ok: false, error: 'magic link already used' };
  if (isExpired(link.expiresAt)) return { ok: false, error: 'magic link expired' };

  await store.patch(`auth/magic-links/${token}`, { usedAt: ts() });

  let user = unwrap(await store.get(`auth/users/${link.email}`));
  const isNew = !user;
  if (!user) {
    const placeholderHash = await hashPassword(crypto.randomUUID());
    user = {
      email: link.email, name: link.email.split('@')[0], role: 'user',
      status: 'active', passwordHash: placeholderHash, createdAt: ts(), lastLoginAt: null,
    };
    await store.set(`auth/users/${link.email}`, user, { mode: 'replace' });
  }
  if (user.status === 'suspended') return { ok: false, error: 'account suspended' };

  const sessionToken = crypto.randomUUID();
  await store.set(`auth/sessions/${sessionToken}`, {
    token: sessionToken, email: link.email, expiresAt: expiresIn(24), createdAt: ts(),
    userAgent: opts?.userAgent || null, ip: opts?.ip || null, method: 'magic-link',
  }, { mode: 'replace' });
  await store.patch(`auth/users/${link.email}`, { lastLoginAt: ts() });

  return { ok: true, data: { token: sessionToken, user: stripSensitive(user), isNewUser: isNew } };
}

// ============================================================================
// Password Reset
// ============================================================================

async function requestPasswordReset(store: any, email: string) {
  if (!email) return { ok: false, error: 'email required' };
  const user = unwrap(await store.get(`auth/users/${email}`));
  if (!user) return { ok: false, error: 'user not found' };

  const token = crypto.randomUUID();
  await store.set(`auth/reset-tokens/${token}`, {
    token, email, expiresAt: expiresIn(1), createdAt: ts(), usedAt: null,
  }, { mode: 'replace' });
  return { ok: true, data: { token, email } };
}

async function resetPassword(store: any, token: string, newPassword: string) {
  if (!newPassword) return { ok: false, error: 'new password required' };
  const resetToken = unwrap(await store.get(`auth/reset-tokens/${token}`));
  if (!resetToken) return { ok: false, error: 'invalid reset token' };
  if (resetToken.usedAt) return { ok: false, error: 'reset token already used' };
  if (isExpired(resetToken.expiresAt)) return { ok: false, error: 'reset token expired' };

  await store.patch(`auth/reset-tokens/${token}`, { usedAt: ts() });
  const newHash = await hashPassword(newPassword);
  await store.patch(`auth/users/${resetToken.email}`, { passwordHash: newHash });
  return { ok: true, data: { email: resetToken.email } };
}

// ============================================================================
// API Keys
// ============================================================================

async function createApiKey(
  store: any, sessionToken: string,
  opts?: { name?: string; expiresInHours?: number },
) {
  const profile = await getProfile(store, sessionToken);
  if (!profile.ok) return profile;

  const key = `sk_${crypto.randomUUID().replace(/-/g, '')}`;
  const apiKey = {
    key, email: profile.data.email, name: opts?.name || 'default',
    createdAt: ts(), expiresAt: opts?.expiresInHours ? expiresIn(opts.expiresInHours) : null,
    revokedAt: null, lastUsedAt: null,
  };
  await store.set(`auth/api-keys/${key}`, apiKey, { mode: 'replace' });
  return { ok: true, data: apiKey };
}

async function validateApiKey(store: any, key: string) {
  const apiKey = unwrap(await store.get(`auth/api-keys/${key}`));
  if (!apiKey) return { ok: false, error: 'invalid api key' };
  if (apiKey.revokedAt) return { ok: false, error: 'api key revoked' };
  if (apiKey.expiresAt && isExpired(apiKey.expiresAt)) return { ok: false, error: 'api key expired' };

  await store.patch(`auth/api-keys/${key}`, { lastUsedAt: ts() });
  const user = unwrap(await store.get(`auth/users/${apiKey.email}`));
  if (!user) return { ok: false, error: 'user not found' };
  return { ok: true, data: { key: apiKey, user: stripSensitive(user) } };
}

async function revokeApiKey(store: any, sessionToken: string, key: string) {
  const profile = await getProfile(store, sessionToken);
  if (!profile.ok) return profile;

  const apiKey = unwrap(await store.get(`auth/api-keys/${key}`));
  if (!apiKey) return { ok: false, error: 'api key not found' };
  if (apiKey.email !== profile.data.email && profile.data.role !== 'admin') {
    return { ok: false, error: 'unauthorized' };
  }
  await store.patch(`auth/api-keys/${key}`, { revokedAt: ts() });
  return { ok: true };
}

// ============================================================================
// Session Refresh / Rotation
// ============================================================================

async function refreshSession(
  store: any, token: string, opts?: { rotate?: boolean },
) {
  const session = unwrap(await store.get(`auth/sessions/${token}`));
  if (!session) return { ok: false, error: 'session not found' };
  if (isExpired(session.expiresAt)) {
    await store.delete(`auth/sessions/${token}`);
    return { ok: false, error: 'session expired' };
  }

  if (opts?.rotate) {
    const newToken = crypto.randomUUID();
    const newExpiry = expiresIn(24);
    await store.set(`auth/sessions/${newToken}`, {
      ...session, token: newToken, expiresAt: newExpiry, rotatedFrom: token,
    }, { mode: 'replace' });
    await store.delete(`auth/sessions/${token}`);
    return { ok: true, data: { token: newToken, expiresAt: newExpiry } };
  } else {
    const newExpiry = expiresIn(24);
    await store.patch(`auth/sessions/${token}`, { expiresAt: newExpiry });
    return { ok: true, data: { token, expiresAt: newExpiry } };
  }
}

// ============================================================================
// Audit Log
// ============================================================================

async function auditLog(
  store: any,
  event: { action: string; email?: string; detail?: string; ip?: string },
) {
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const entry = {
    id, action: event.action, email: event.email || null,
    detail: event.detail || null, ip: event.ip || null, timestamp: ts(),
  };
  await store.set(`auth/audit-log/${id}`, entry, { mode: 'replace' });
  return { ok: true, data: entry };
}

// ============================================================================
// Email Verification
// ============================================================================

async function sendVerification(store: any, email: string) {
  if (!email) return { ok: false, error: 'email required' };
  const user = unwrap(await store.get(`auth/users/${email}`));
  if (!user) return { ok: false, error: 'user not found' };

  const token = crypto.randomUUID();
  await store.set(`auth/verify-tokens/${token}`, {
    token, email, expiresAt: expiresIn(24), createdAt: ts(), verifiedAt: null,
  }, { mode: 'replace' });
  return { ok: true, data: { token, email } };
}

async function verifyEmail(store: any, token: string) {
  const verifyToken = unwrap(await store.get(`auth/verify-tokens/${token}`));
  if (!verifyToken) return { ok: false, error: 'invalid verification token' };
  if (verifyToken.verifiedAt) return { ok: false, error: 'already verified' };
  if (isExpired(verifyToken.expiresAt)) return { ok: false, error: 'verification token expired' };

  await store.patch(`auth/verify-tokens/${token}`, { verifiedAt: ts() });
  await store.patch(`auth/users/${verifyToken.email}`, { emailVerified: true });
  return { ok: true, data: { email: verifyToken.email } };
}

// ============================================================================
// Simulation data pools
// ============================================================================

const FIRST_NAMES = ['Alex', 'Jordan', 'Morgan', 'Casey', 'Taylor', 'Riley', 'Avery', 'Quinn'];
const LAST_NAMES = ['Chen', 'Patel', 'Kim', 'Santos', 'Johansson', 'Dubois', 'Nakamura', 'Reed'];
const DOMAINS = ['acme.com', 'startup.io', 'bigcorp.co', 'devtools.dev', 'research.org'];
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
  'Mozilla/5.0 (Windows NT 10.0)',
  'Chrome/120.0 Mobile',
  'Safari/17.2',
];
const IPS = ['192.168.1.10', '10.0.0.42', '172.16.0.100', '203.0.113.50', '198.51.100.23'];

function randomPerson() {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const domain = pick(DOMAINS);
  return {
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`,
    password: `${first.toLowerCase()}-pass-${Math.floor(Math.random() * 1000)}`,
  };
}

// ============================================================================
// Simulation
// ============================================================================

async function main() {
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551  Tiny Auth \u2014 Simulation (local-json)                    \u2551');
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');

  const jsonAdapter = createLocalJsonAdapter({ baseDir: JSON_DIR, prettyPrint: true });
  const store = createSmallstore({
    adapters: {
      json: jsonAdapter,
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'json',
    mounts: {
      'cache/*': 'memory',
    },
  });

  // ── Phase 1: Bootstrap admin ──────────────────────────────────
  console.log('\n\u2500\u2500 Phase 1: Admin bootstrap \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const adminPassword = 'demo-only-not-a-real-password'; // pragma: allowlist secret
  const adminHash = await hashPassword(adminPassword);
  await store.set('auth/users/admin@example.com', {
    email: 'admin@example.com',
    name: 'System Admin',
    role: 'admin',
    status: 'active',
    passwordHash: adminHash,
    createdAt: ts(),
    lastLoginAt: null,
  }, { mode: 'replace' });
  log('*', 'Admin account created: admin@example.com');

  const adminLogin = await login(store, {
    email: 'admin@example.com',
    password: adminPassword,
    userAgent: 'AdminPanel/1.0',
    ip: '10.0.0.1',
  });
  const adminToken = adminLogin.data.token;
  log('*', `Admin logged in: token ${adminToken.slice(0, 8)}...`);
  await sleep(50);

  // ── Phase 2: Create invites ───────────────────────────────────
  console.log('\n\u2500\u2500 Phase 2: Creating invites \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const inviteCodes: string[] = [];
  const people = Array.from({ length: 5 }, () => randomPerson());

  for (let i = 0; i < people.length; i++) {
    const person = people[i];
    const role = i === 0 ? 'admin' : i < 3 ? 'user' : 'viewer';
    const invite = await createInvite(store, adminToken, {
      email: person.email,
      role,
    });
    inviteCodes.push(invite.data.code);
    log('+', `Invite ${invite.data.code} for ${person.email} (${role})`);
    await sleep(50);
  }

  // ── Phase 3: Users register ───────────────────────────────────
  console.log('\n\u2500\u2500 Phase 3: User registration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  for (let i = 0; i < people.length; i++) {
    const person = people[i];
    const result = await register(store, {
      email: person.email,
      password: person.password,
      name: person.name,
      inviteCode: inviteCodes[i],
    });
    if (result.ok) {
      log('+', `Registered: ${person.name} <${person.email}> (${result.data.role})`);
    } else {
      log('!', `Failed: ${person.email} - ${result.error}`);
    }
    await sleep(50);
  }

  // ── Phase 4: Users login ──────────────────────────────────────
  console.log('\n\u2500\u2500 Phase 4: User login \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const sessions: { person: typeof people[0]; token: string }[] = [];

  for (const person of people) {
    const result = await login(store, {
      email: person.email,
      password: person.password,
      userAgent: pick(USER_AGENTS),
      ip: pick(IPS),
    });
    if (result.ok) {
      sessions.push({ person, token: result.data.token });
      log('>', `${person.name} logged in (${result.data.token.slice(0, 8)}...)`);
    } else {
      log('!', `Login failed: ${person.email} - ${result.error}`);
    }
    await sleep(30);
  }

  // ── Phase 5: Check profiles ───────────────────────────────────
  console.log('\n\u2500\u2500 Phase 5: Profile checks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  for (const s of sessions) {
    const profile = await getProfile(store, s.token);
    if (profile.ok) {
      log('=', `${profile.data.name} (${profile.data.role}) - OK`);
    } else {
      log('!', `Profile failed for ${s.person.email}: ${profile.error}`);
    }
    await sleep(20);
  }

  // ── Phase 6: Magic link login ───────────────────────────────────
  console.log('\n\u2500\u2500 Phase 6: Magic link login \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Existing user logs in via magic link (passwordless)
  const existingPerson = people[0];
  const existingMagic = await sendMagicLink(store, existingPerson.email);
  log('@', `Magic link sent to ${existingPerson.email}: ${existingMagic.data.token.slice(0, 8)}...`);
  await sleep(30);

  const existingVerify = await verifyMagicLink(store, existingMagic.data.token, {
    userAgent: 'MagicLink/1.0',
    ip: pick(IPS),
  });
  if (existingVerify.ok) {
    sessions.push({ person: existingPerson, token: existingVerify.data.token });
    log('@', `${existingPerson.name} logged in via magic link (new session)`);
  }
  await sleep(30);

  // Brand new users sign up via magic link (auto-registration)
  const magicNewUsers = [
    `newcomer1@${pick(DOMAINS)}`,
    `newcomer2@${pick(DOMAINS)}`,
    `newcomer3@${pick(DOMAINS)}`,
  ];

  for (const email of magicNewUsers) {
    const magic = await sendMagicLink(store, email);
    log('@', `Magic link sent to ${email}: ${magic.data.token.slice(0, 8)}...`);
    await sleep(20);

    const verify = await verifyMagicLink(store, magic.data.token, {
      userAgent: pick(USER_AGENTS),
      ip: pick(IPS),
    });
    if (verify.ok) {
      const label = verify.data.isNewUser ? 'NEW' : 'existing';
      log('@', `${email} signed in (${label} user, session: ${verify.data.token.slice(0, 8)}...)`);
    }
    await sleep(30);
  }

  // ── Phase 7: Password reset ──────────────────────────────────
  console.log('\n\u2500\u2500 Phase 7: Password reset \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const resetPerson = people[1];
  const resetReq = await requestPasswordReset(store, resetPerson.email);
  if (resetReq.ok) {
    log('!', `Password reset requested for ${resetPerson.email}`);
    await sleep(30);
    const newPass = `${resetPerson.name.split(' ')[0].toLowerCase()}-reset-${Math.floor(Math.random() * 9999)}`;
    const resetResult = await resetPassword(store, resetReq.data.token, newPass);
    if (resetResult.ok) {
      log('!', `Password reset completed for ${resetPerson.email}`);
      resetPerson.password = newPass;
    }
    await sleep(30);
    const testLogin = await login(store, { email: resetPerson.email, password: newPass });
    if (testLogin.ok) {
      log('!', `${resetPerson.name} logged in with new password`);
    }
  }

  // ── Phase 8: API keys ─────────────────────────────────────────
  console.log('\n\u2500\u2500 Phase 8: API keys \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const apiKeys: string[] = [];
  for (let i = 0; i < 3; i++) {
    const key = await createApiKey(store, adminToken, {
      name: `service-${i + 1}`,
      expiresInHours: 720,
    });
    if (key.ok) {
      apiKeys.push(key.data.key);
      log('+', `API key created: ${key.data.key.slice(0, 16)}... (${key.data.name})`);
    }
    await sleep(20);
  }
  if (apiKeys.length > 0) {
    const valid = await validateApiKey(store, apiKeys[0]);
    if (valid.ok) {
      log('=', `API key validated for ${valid.data.user.email}`);
    }
  }
  if (apiKeys.length > 1) {
    const revoke = await revokeApiKey(store, adminToken, apiKeys[1]);
    if (revoke.ok) {
      log('-', `API key revoked: ${apiKeys[1].slice(0, 16)}...`);
    }
  }

  // ── Phase 9: Session refresh ──────────────────────────────────
  console.log('\n\u2500\u2500 Phase 9: Session refresh \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const extended = await refreshSession(store, adminToken);
  if (extended.ok) {
    log('~', `Admin session extended (same token)`);
  }
  if (sessions.length > 0) {
    const s = sessions[0];
    const rotated = await refreshSession(store, s.token, { rotate: true });
    if (rotated.ok) {
      log('~', `${s.person.name} session rotated: ${s.token.slice(0, 8)}... -> ${rotated.data.token.slice(0, 8)}...`);
      s.token = rotated.data.token;
    }
  }
  await sleep(30);

  // ── Phase 10: Audit log ───────────────────────────────────────
  console.log('\n\u2500\u2500 Phase 10: Audit log \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const auditEvents = [
    { action: 'login', email: 'admin@example.com', detail: 'admin login', ip: '10.0.0.1' },
    { action: 'register', email: people[0].email, detail: 'new user registered' },
    { action: 'login_failed', email: 'hacker@evil.com', detail: 'invalid credentials', ip: '203.0.113.99' },
    { action: 'password_reset', email: resetPerson.email, detail: 'password changed' },
    { action: 'api_key_created', email: 'admin@example.com', detail: 'ci-pipeline key' },
  ];
  for (const event of auditEvents) {
    await auditLog(store, event);
    log('>', `Audit: ${event.action} - ${event.email || 'n/a'}`);
    await sleep(15);
  }

  // ── Phase 11: Email verification ──────────────────────────────
  console.log('\n\u2500\u2500 Phase 11: Email verification \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  for (const person of people.slice(0, 3)) {
    const verifyReq = await sendVerification(store, person.email);
    if (verifyReq.ok) {
      log('@', `Verification sent to ${person.email}`);
      await sleep(20);
      const verified = await verifyEmail(store, verifyReq.data.token);
      if (verified.ok) {
        log('@', `${person.email} email verified`);
      }
    }
    await sleep(20);
  }

  // ── Phase 12: Some users logout ────────────────────────────────
  console.log('\n\u2500\u2500 Phase 12: Logout \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Logout the last 2 users
  for (const s of sessions.slice(-2)) {
    await store.delete(`auth/sessions/${s.token}`);
    log('<', `${s.person.name} logged out`);
    await sleep(30);
  }

  // Flush writes to disk
  await jsonAdapter.flush();

  // ── Phase 13: Admin stats ─────────────────────────────────────
  console.log('\n\u2500\u2500 Phase 13: Admin overview \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const userKeys = await store.keys('auth/users');
  const sessionKeys = await store.keys('auth/sessions');
  const inviteKeys = await store.keys('auth/invites');
  const magicKeys = await store.keys('auth/magic-links');

  log('#', `Users: ${userKeys.length}`);
  log('#', `Active sessions: ${sessionKeys.length}`);
  log('#', `Invites: ${inviteKeys.length} total`);
  log('#', `Magic links: ${magicKeys.length} issued`);

  const resetKeys = await store.keys('auth/reset-tokens');
  const apiKeyKeys = await store.keys('auth/api-keys');
  const auditLogKeys = await store.keys('auth/audit-log');
  const verifyKeys = await store.keys('auth/verify-tokens');

  log('#', `Reset Tokens: ${resetKeys.length}`);
  log('#', `API Keys: ${apiKeyKeys.length}`);
  log('#', `Audit Log: ${auditLogKeys.length} entries`);
  log('#', `Verify Tokens: ${verifyKeys.length}`);

  // Count used invites (keys are relative, prepend collection prefix)
  let usedCount = 0;
  for (const k of inviteKeys) {
    const fullKey = k.startsWith('auth/') ? k : `auth/${k}`;
    const inv = unwrap(await store.get(fullKey));
    if (inv && inv.usedBy) usedCount++;
  }
  log('#', `Invites used: ${usedCount} / ${inviteKeys.length}`);

  // ── Summary ───────────────────────────────────────────────────
  console.log(`\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
  console.log('  Auth Simulation complete!');
  console.log(`  Data: ${JSON_DIR}`);
  console.log(`  Users: ${userKeys.length}, Sessions: ${sessionKeys.length}, Invites: ${inviteKeys.length}, Magic Links: ${magicKeys.length}`);
  console.log(`  Reset Tokens: ${resetKeys.length}, API Keys: ${apiKeyKeys.length}, Audit Log: ${auditLogKeys.length}, Verify Tokens: ${verifyKeys.length}`);
  console.log('');
  console.log('  Browse your data:');
  console.log(`    ls ${JSON_DIR}/smallstore/auth/`);
  console.log(`    cat ${JSON_DIR}/smallstore/auth/users/*.json`);
  console.log(`\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n`);
  console.log('  Run again to add more data. Use --clean to reset.\n');
}

main().catch((err) => {
  console.error(`\n\u2717 FAILED: ${err.message}`);
  console.error(err.stack);
  Deno.exit(1);
});
