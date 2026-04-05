#!/usr/bin/env -S deno run --allow-all
/**
 * Tiny Auth — Minimal User Auth System
 *
 * A complete auth flow (register, login, sessions, invites) backed by
 * smallstore + SQLite. Exercises CRUD, query, search, and patch — proving
 * smallstore works for real auth use cases.
 *
 * Collections:
 *   auth/users/{email}       — user accounts (email as primary key)
 *   auth/sessions/{token}   — active sessions (UUID tokens)
 *   auth/invites/{code}     — invite codes
 *   auth/magic-links/{token} — passwordless magic link tokens
 *   auth/reset-tokens/{token} — password reset tokens
 *   auth/api-keys/{key}       — long-lived API keys
 *   auth/audit-log/{id}       — audit event log
 *   auth/verify-tokens/{token} — email verification tokens
 *
 * Data persists in ./data/ between runs. Use --clean to reset.
 *
 * Run:
 *   deno task auth           # run tests (data persists)
 *   deno task auth --clean   # wipe data and re-run
 */

import { join } from 'https://deno.land/std@0.224.0/path/mod.ts';
import {
  createSmallstore,
  createMemoryAdapter,
  createSQLiteAdapter,
} from '../../mod.ts';

// ============================================================================
// Config
// ============================================================================

const APP_DIR = import.meta.dirname!;
const DATA_DIR = join(APP_DIR, 'data');
const DB_PATH = join(DATA_DIR, 'store.db');

if (Deno.args.includes('--clean')) {
  try { await Deno.remove(DATA_DIR, { recursive: true }); } catch { /* ok */ }
  console.log('Cleaned data directory.\n');
}
await Deno.mkdir(DATA_DIR, { recursive: true });

// ============================================================================
// Helpers
// ============================================================================

let checkCount = 0;

function ok(label: string) {
  checkCount++;
  console.log(`  \u2713 ${label}`);
}

function section(label: string) {
  console.log(`\n\u2500\u2500 ${label} ${'\u2500'.repeat(60 - label.length)}`);
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
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

function ts(): string {
  return new Date().toISOString();
}

function expiresIn(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

function expiresInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function isExpired(isoDate: string): boolean {
  return new Date(isoDate).getTime() < Date.now();
}

// ============================================================================
// Password Hashing (Web Crypto — no external deps)
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

// ============================================================================
// Auth Result Type
// ============================================================================

interface AuthResult {
  ok: boolean;
  data?: any;
  error?: string;
}

function stripSensitive(user: any): any {
  if (!user) return user;
  const { passwordHash: _, ...safe } = user;
  return safe;
}

// ============================================================================
// Auth Functions (thin layer over smallstore CRUD)
// ============================================================================

async function register(
  store: any,
  input: { email: string; password: string; name: string; inviteCode?: string },
): Promise<AuthResult> {
  const { email, password, name, inviteCode } = input;

  if (!email) return { ok: false, error: 'email required' };
  if (!password) return { ok: false, error: 'password required' };

  // Check duplicate
  const existing = await store.get(`auth/users/${email}`);
  if (existing !== null && unwrap(existing) !== null) {
    return { ok: false, error: 'email already registered' };
  }

  // Validate invite if provided
  let role = 'user';
  if (inviteCode) {
    const invite = unwrap(await store.get(`auth/invites/${inviteCode}`));
    if (!invite) return { ok: false, error: 'invalid invite code' };
    if (invite.usedBy) return { ok: false, error: 'invite already used' };
    if (invite.expiresAt && isExpired(invite.expiresAt)) {
      return { ok: false, error: 'invite expired' };
    }
    if (invite.email && invite.email !== email) {
      return { ok: false, error: 'invite assigned to different email' };
    }
    role = invite.role || 'user';

    // Mark invite as used
    await store.patch(`auth/invites/${inviteCode}`, {
      usedBy: email,
      usedAt: ts(),
    });
  }

  const passwordHash = await hashPassword(password);

  const user = {
    email,
    name,
    role,
    status: 'active',
    passwordHash,
    createdAt: ts(),
    lastLoginAt: null,
  };

  await store.set(`auth/users/${email}`, user, { mode: 'replace' });

  return { ok: true, data: stripSensitive(user) };
}

async function login(
  store: any,
  input: { email: string; password: string; userAgent?: string; ip?: string },
): Promise<AuthResult> {
  const { email, password, userAgent, ip } = input;

  const user = unwrap(await store.get(`auth/users/${email}`));
  if (!user) return { ok: false, error: 'user not found' };
  if (user.status === 'suspended') return { ok: false, error: 'account suspended' };
  if (user.status === 'pending') return { ok: false, error: 'account pending approval' };

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return { ok: false, error: 'invalid password' };

  const token = crypto.randomUUID();
  const session = {
    token,
    email,
    expiresAt: expiresIn(24),
    createdAt: ts(),
    userAgent: userAgent || null,
    ip: ip || null,
  };

  await store.set(`auth/sessions/${token}`, session, { mode: 'replace' });
  await store.patch(`auth/users/${email}`, { lastLoginAt: ts() });

  return { ok: true, data: { token, user: stripSensitive(user) } };
}

async function logout(store: any, token: string): Promise<AuthResult> {
  const session = await store.get(`auth/sessions/${token}`);
  if (session === null || unwrap(session) === null) {
    return { ok: false, error: 'session not found' };
  }
  await store.delete(`auth/sessions/${token}`);
  return { ok: true };
}

async function getProfile(store: any, token: string): Promise<AuthResult> {
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
): Promise<AuthResult> {
  // Authenticate caller
  const profile = await getProfile(store, token);
  if (!profile.ok) return profile;
  if (profile.data.role !== 'admin') {
    return { ok: false, error: 'admin only' };
  }

  const code = crypto.randomUUID().slice(0, 8);
  const invite = {
    code,
    email: opts?.email || null,
    role: opts?.role || 'user',
    usedBy: null,
    usedAt: null,
    expiresAt: expiresIn(72),
    createdAt: ts(),
  };

  await store.set(`auth/invites/${code}`, invite, { mode: 'replace' });

  return { ok: true, data: invite };
}

// ============================================================================
// Magic Link Functions (passwordless login)
// ============================================================================

async function sendMagicLink(
  store: any,
  email: string,
): Promise<AuthResult> {
  if (!email) return { ok: false, error: 'email required' };

  const token = crypto.randomUUID();
  const magicLink = {
    token,
    email,
    expiresAt: expiresInMinutes(15), // 15-minute window
    createdAt: ts(),
    usedAt: null,
  };

  await store.set(`auth/magic-links/${token}`, magicLink, { mode: 'replace' });

  // In a real system, this would send an email with a link like:
  //   https://app.example.com/auth/magic?token={token}
  // For this demo, we just return the token.
  return { ok: true, data: { token, email, expiresAt: magicLink.expiresAt } };
}

async function verifyMagicLink(
  store: any,
  token: string,
  opts?: { userAgent?: string; ip?: string },
): Promise<AuthResult> {
  const link = unwrap(await store.get(`auth/magic-links/${token}`));
  if (!link) return { ok: false, error: 'invalid magic link' };
  if (link.usedAt) return { ok: false, error: 'magic link already used' };
  if (isExpired(link.expiresAt)) return { ok: false, error: 'magic link expired' };

  // Mark the link as used
  await store.patch(`auth/magic-links/${token}`, { usedAt: ts() });

  // Auto-create user if they don't exist yet
  let user = unwrap(await store.get(`auth/users/${link.email}`));
  if (!user) {
    // New user — create with a random password hash (they'll use magic links)
    const placeholderHash = await hashPassword(crypto.randomUUID());
    user = {
      email: link.email,
      name: link.email.split('@')[0], // derive name from email
      role: 'user',
      status: 'active',
      passwordHash: placeholderHash,
      createdAt: ts(),
      lastLoginAt: null,
    };
    await store.set(`auth/users/${link.email}`, user, { mode: 'replace' });
  }

  // Check account status
  if (user.status === 'suspended') return { ok: false, error: 'account suspended' };

  // Create session (same as password login)
  const sessionToken = crypto.randomUUID();
  await store.set(`auth/sessions/${sessionToken}`, {
    token: sessionToken,
    email: link.email,
    expiresAt: expiresIn(24),
    createdAt: ts(),
    userAgent: opts?.userAgent || null,
    ip: opts?.ip || null,
    method: 'magic-link', // track auth method
  }, { mode: 'replace' });
  await store.patch(`auth/users/${link.email}`, { lastLoginAt: ts() });

  return { ok: true, data: { token: sessionToken, user: stripSensitive(user), isNewUser: !user.lastLoginAt } };
}

// ============================================================================
// Password Reset
// ============================================================================

async function requestPasswordReset(
  store: any,
  email: string,
): Promise<AuthResult> {
  if (!email) return { ok: false, error: 'email required' };

  const user = unwrap(await store.get(`auth/users/${email}`));
  if (!user) return { ok: false, error: 'user not found' };

  const token = crypto.randomUUID();
  const resetExpiry = expiresIn(1); // 1-hour window
  await store.set(`auth/reset-tokens/${token}`, {
    token,
    email,
    expiresAt: resetExpiry,
    createdAt: ts(),
    usedAt: null,
  }, { mode: 'replace' });

  return { ok: true, data: { token, email, expiresAt: resetExpiry } };
}

async function resetPassword(
  store: any,
  token: string,
  newPassword: string,
): Promise<AuthResult> {
  if (!newPassword) return { ok: false, error: 'new password required' };

  const resetToken = unwrap(await store.get(`auth/reset-tokens/${token}`));
  if (!resetToken) return { ok: false, error: 'invalid reset token' };
  if (resetToken.usedAt) return { ok: false, error: 'reset token already used' };
  if (isExpired(resetToken.expiresAt)) return { ok: false, error: 'reset token expired' };

  // Mark token as used
  await store.patch(`auth/reset-tokens/${token}`, { usedAt: ts() });

  // Update password
  const newHash = await hashPassword(newPassword);
  await store.patch(`auth/users/${resetToken.email}`, { passwordHash: newHash });

  return { ok: true, data: { email: resetToken.email } };
}

// ============================================================================
// API Keys
// ============================================================================

async function createApiKey(
  store: any,
  sessionToken: string,
  opts?: { name?: string; expiresInHours?: number },
): Promise<AuthResult> {
  const profile = await getProfile(store, sessionToken);
  if (!profile.ok) return profile;

  const key = `sk_${crypto.randomUUID().replace(/-/g, '')}`;
  const apiKey = {
    key,
    email: profile.data.email,
    name: opts?.name || 'default',
    createdAt: ts(),
    expiresAt: opts?.expiresInHours ? expiresIn(opts.expiresInHours) : null,
    revokedAt: null,
    lastUsedAt: null,
  };

  await store.set(`auth/api-keys/${key}`, apiKey, { mode: 'replace' });

  return { ok: true, data: apiKey };
}

async function validateApiKey(
  store: any,
  key: string,
): Promise<AuthResult> {
  const apiKey = unwrap(await store.get(`auth/api-keys/${key}`));
  if (!apiKey) return { ok: false, error: 'invalid api key' };
  if (apiKey.revokedAt) return { ok: false, error: 'api key revoked' };
  if (apiKey.expiresAt && isExpired(apiKey.expiresAt)) return { ok: false, error: 'api key expired' };

  await store.patch(`auth/api-keys/${key}`, { lastUsedAt: ts() });

  const user = unwrap(await store.get(`auth/users/${apiKey.email}`));
  if (!user) return { ok: false, error: 'user not found' };
  if (user.status !== 'active') return { ok: false, error: 'account not active' };

  return { ok: true, data: { key: apiKey, user: stripSensitive(user) } };
}

async function revokeApiKey(
  store: any,
  sessionToken: string,
  key: string,
): Promise<AuthResult> {
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
  store: any,
  token: string,
  opts?: { rotate?: boolean },
): Promise<AuthResult> {
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
      ...session,
      token: newToken,
      expiresAt: newExpiry,
      rotatedFrom: token,
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
): Promise<AuthResult> {
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const entry = {
    id,
    action: event.action,
    email: event.email || null,
    detail: event.detail || null,
    ip: event.ip || null,
    timestamp: ts(),
  };

  await store.set(`auth/audit-log/${id}`, entry, { mode: 'replace' });
  return { ok: true, data: entry };
}

// ============================================================================
// Email Verification
// ============================================================================

async function sendVerification(
  store: any,
  email: string,
): Promise<AuthResult> {
  if (!email) return { ok: false, error: 'email required' };

  const user = unwrap(await store.get(`auth/users/${email}`));
  if (!user) return { ok: false, error: 'user not found' };

  const token = crypto.randomUUID();
  await store.set(`auth/verify-tokens/${token}`, {
    token,
    email,
    expiresAt: expiresIn(24),
    createdAt: ts(),
    verifiedAt: null,
  }, { mode: 'replace' });

  return { ok: true, data: { token, email } };
}

async function verifyEmail(
  store: any,
  token: string,
): Promise<AuthResult> {
  const verifyToken = unwrap(await store.get(`auth/verify-tokens/${token}`));
  if (!verifyToken) return { ok: false, error: 'invalid verification token' };
  if (verifyToken.verifiedAt) return { ok: false, error: 'already verified' };
  if (isExpired(verifyToken.expiresAt)) return { ok: false, error: 'verification token expired' };

  await store.patch(`auth/verify-tokens/${token}`, { verifiedAt: ts() });
  await store.patch(`auth/users/${verifyToken.email}`, { emailVerified: true });

  return { ok: true, data: { email: verifyToken.email } };
}

// ============================================================================
// Seed Data
// ============================================================================

// Demo-only seed data — NOT real credentials
const DEMO_PASSWORD = 'demo-only-not-a-real-password'; // pragma: allowlist secret
const ADMIN = {
  email: 'admin@example.com',
  name: 'Admin User',
  password: DEMO_PASSWORD,
};

const USERS = [
  { email: 'alice@example.com', name: 'Alice Smith', password: DEMO_PASSWORD },
  { email: 'bob@example.com', name: 'Bob Johnson', password: DEMO_PASSWORD },
];

const SUSPENDED = {
  email: 'charlie@example.com',
  name: 'Charlie (Suspended)',
  password: DEMO_PASSWORD,
};

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551  Tiny Auth \u2014 Minimal User Auth System                    \u2551');
  console.log(`\u2551  Data: ${DATA_DIR}`);
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');

  const store = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      sqlite: createSQLiteAdapter({ path: DB_PATH }),
    },
    defaultAdapter: 'sqlite',
    mounts: {
      'cache/*': 'memory',
    },
  });

  // ──────────────────────────────────────────────────────────────
  // 1. Seed Data
  // ──────────────────────────────────────────────────────────────
  section('1. Seed Data');

  // Clear previous data for clean run
  for (const col of ['auth/users', 'auth/sessions', 'auth/invites', 'auth/magic-links', 'auth/reset-tokens', 'auth/api-keys', 'auth/audit-log', 'auth/verify-tokens']) {
    const keys = await store.keys(col);
    for (const k of keys) await store.delete(k);
  }
  ok('cleared previous auth data');

  // Seed admin directly (bypass registration — we need an admin before invites exist)
  const adminHash = await hashPassword(ADMIN.password);
  await store.set(`auth/users/${ADMIN.email}`, {
    email: ADMIN.email,
    name: ADMIN.name,
    role: 'admin',
    status: 'active',
    passwordHash: adminHash,
    createdAt: ts(),
    lastLoginAt: null,
  }, { mode: 'replace' });
  ok(`seeded admin: ${ADMIN.email}`);

  // Verify admin's password hash works
  const adminUser = unwrap(await store.get(`auth/users/${ADMIN.email}`));
  assert(adminUser.passwordHash !== ADMIN.password, 'hash is not plaintext');
  assert(await verifyPassword(ADMIN.password, adminUser.passwordHash), 'password verifies');
  ok('admin password hash valid');

  // Register normal users via register()
  for (const u of USERS) {
    const r = await register(store, u);
    assert(r.ok, `register ${u.email} should succeed`);
    assert(!r.data.passwordHash, 'response should not contain passwordHash');
  }
  ok(`registered ${USERS.length} users via register()`);

  // Seed suspended user directly
  const susHash = await hashPassword(SUSPENDED.password);
  await store.set(`auth/users/${SUSPENDED.email}`, {
    email: SUSPENDED.email,
    name: SUSPENDED.name,
    role: 'user',
    status: 'suspended',
    passwordHash: susHash,
    createdAt: ts(),
    lastLoginAt: null,
  }, { mode: 'replace' });
  ok(`seeded suspended user: ${SUSPENDED.email}`);

  // ──────────────────────────────────────────────────────────────
  // 2. Registration Edge Cases
  // ──────────────────────────────────────────────────────────────
  section('2. Registration Edge Cases');

  // Duplicate email
  const dup = await register(store, { email: ADMIN.email, password: 'x', name: 'Dup' });
  assert(!dup.ok && dup.error === 'email already registered', 'duplicate rejected');
  ok('duplicate email rejected');

  // Empty password
  const noPass = await register(store, { email: 'new@example.com', password: '', name: 'No Pass' });
  assert(!noPass.ok && noPass.error === 'password required', 'empty password rejected');
  ok('empty password rejected');

  // Empty email
  const noEmail = await register(store, { email: '', password: 'pass', name: 'No Email' });
  assert(!noEmail.ok && noEmail.error === 'email required', 'empty email rejected');
  ok('empty email rejected');

  // New valid registration
  const dave = await register(store, { email: 'dave@example.com', password: 'dave-pass', name: 'Dave Wilson' });
  assert(dave.ok, 'dave registration succeeds');
  assert(dave.data.role === 'user', 'default role is user');
  ok('new user "dave@example.com" registered with default role');

  // ──────────────────────────────────────────────────────────────
  // 3. Login Flows
  // ──────────────────────────────────────────────────────────────
  section('3. Login Flows');

  // Admin login
  const adminLogin = await login(store, {
    email: ADMIN.email,
    password: ADMIN.password,
    userAgent: 'TestRunner/1.0',
    ip: '127.0.0.1',
  });
  assert(adminLogin.ok, 'admin login succeeds');
  assert(adminLogin.data.token.length > 0, 'received session token');
  ok(`admin login: token ${adminLogin.data.token.slice(0, 8)}...`);

  const adminToken = adminLogin.data.token;

  // Alice login
  const aliceLogin = await login(store, { email: 'alice@example.com', password: DEMO_PASSWORD });
  assert(aliceLogin.ok, 'alice login succeeds');
  ok(`alice login: token ${aliceLogin.data.token.slice(0, 8)}...`);

  const aliceToken = aliceLogin.data.token;

  // Wrong password
  const wrongPass = await login(store, { email: ADMIN.email, password: 'wrong-password' });
  assert(!wrongPass.ok && wrongPass.error === 'invalid password', 'wrong password rejected');
  ok('wrong password rejected');

  // Non-existent user
  const noUser = await login(store, { email: 'nobody@example.com', password: 'pass' });
  assert(!noUser.ok && noUser.error === 'user not found', 'missing user rejected');
  ok('non-existent user rejected');

  // Suspended user
  const susLogin = await login(store, { email: SUSPENDED.email, password: SUSPENDED.password });
  assert(!susLogin.ok && susLogin.error === 'account suspended', 'suspended rejected');
  ok('suspended account rejected');

  // Verify lastLoginAt updated
  const adminAfterLogin = unwrap(await store.get(`auth/users/${ADMIN.email}`));
  assert(adminAfterLogin.lastLoginAt !== null, 'lastLoginAt updated');
  ok('lastLoginAt updated after login');

  // ──────────────────────────────────────────────────────────────
  // 4. Session / Profile (GET /auth/me)
  // ──────────────────────────────────────────────────────────────
  section('4. Session / Profile');

  // Valid token
  const adminProfile = await getProfile(store, adminToken);
  assert(adminProfile.ok, 'admin profile succeeds');
  assert(adminProfile.data.email === ADMIN.email, 'correct email');
  assert(adminProfile.data.role === 'admin', 'correct role');
  ok(`admin profile: ${adminProfile.data.name} (${adminProfile.data.role})`);

  // No passwordHash in response
  assert(!adminProfile.data.passwordHash, 'no passwordHash in profile response');
  ok('passwordHash stripped from profile');

  // Alice profile
  const aliceProfile = await getProfile(store, aliceToken);
  assert(aliceProfile.ok && aliceProfile.data.email === 'alice@example.com', 'alice profile ok');
  ok(`alice profile: ${aliceProfile.data.name}`);

  // Invalid token
  const fakeProfile = await getProfile(store, 'fake-token-12345');
  assert(!fakeProfile.ok && fakeProfile.error === 'unauthorized', 'fake token unauthorized');
  ok('invalid token rejected');

  // Expired session
  const expiredToken = 'expired-test-token';
  await store.set(`auth/sessions/${expiredToken}`, {
    token: expiredToken,
    email: ADMIN.email,
    expiresAt: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
    createdAt: ts(),
  }, { mode: 'replace' });
  const expiredProfile = await getProfile(store, expiredToken);
  assert(!expiredProfile.ok && expiredProfile.error === 'session expired', 'expired session detected');
  // Verify expired session was cleaned up
  const expiredGone = await store.get(`auth/sessions/${expiredToken}`);
  assert(expiredGone === null || unwrap(expiredGone) === null, 'expired session auto-deleted');
  ok('expired session rejected and cleaned up');

  // ──────────────────────────────────────────────────────────────
  // 5. Logout
  // ──────────────────────────────────────────────────────────────
  section('5. Logout');

  // Logout alice
  const aliceLogout = await logout(store, aliceToken);
  assert(aliceLogout.ok, 'alice logout succeeds');
  ok('alice logged out');

  // Profile fails after logout
  const afterLogout = await getProfile(store, aliceToken);
  assert(!afterLogout.ok && afterLogout.error === 'unauthorized', 'profile fails after logout');
  ok('profile fails after logout');

  // Double logout (same token)
  const doubleLogout = await logout(store, aliceToken);
  assert(!doubleLogout.ok && doubleLogout.error === 'session not found', 'double logout handled');
  ok('double logout handled gracefully');

  // Re-login alice for later tests
  const aliceReLogin = await login(store, { email: 'alice@example.com', password: DEMO_PASSWORD });
  assert(aliceReLogin.ok, 'alice re-login succeeds');
  ok('alice re-logged in');

  const aliceToken2 = aliceReLogin.data.token;

  // ──────────────────────────────────────────────────────────────
  // 6. Invite System
  // ──────────────────────────────────────────────────────────────
  section('6. Invite System');

  // Admin creates open invite
  const invite1 = await createInvite(store, adminToken);
  assert(invite1.ok, 'admin creates invite');
  assert(invite1.data.code.length === 8, 'invite code is 8 chars');
  ok(`admin created invite: ${invite1.data.code}`);

  // Admin creates targeted invite
  const invite2 = await createInvite(store, adminToken, {
    email: 'eve@example.com',
    role: 'viewer',
  });
  assert(invite2.ok, 'targeted invite created');
  assert(invite2.data.role === 'viewer', 'invite has viewer role');
  ok(`targeted invite for eve: ${invite2.data.code} (viewer)`);

  // Non-admin tries to create invite
  const aliceInvite = await createInvite(store, aliceToken2);
  assert(!aliceInvite.ok && aliceInvite.error === 'admin only', 'non-admin rejected');
  ok('non-admin invite creation rejected');

  // Register with open invite
  const frank = await register(store, {
    email: 'frank@example.com',
    password: 'frank-pass',
    name: 'Frank Lee',
    inviteCode: invite1.data.code,
  });
  assert(frank.ok, 'frank registered with invite');
  assert(frank.data.role === 'user', 'frank got user role from invite');
  ok(`frank registered via invite: role=${frank.data.role}`);

  // Reuse same invite
  const reuse = await register(store, {
    email: 'grace@example.com',
    password: 'grace-pass',
    name: 'Grace Hopper',
    inviteCode: invite1.data.code,
  });
  assert(!reuse.ok && reuse.error === 'invite already used', 'reuse rejected');
  ok('invite reuse rejected');

  // Register eve with targeted invite
  const eve = await register(store, {
    email: 'eve@example.com',
    password: 'eve-pass',
    name: 'Eve Torres',
    inviteCode: invite2.data.code,
  });
  assert(eve.ok, 'eve registered with targeted invite');
  assert(eve.data.role === 'viewer', 'eve got viewer role');
  ok(`eve registered with targeted invite: role=${eve.data.role}`);

  // Non-existent invite code
  const badCode = await register(store, {
    email: 'hank@example.com',
    password: 'hank-pass',
    name: 'Hank',
    inviteCode: 'BADCODE1',
  });
  assert(!badCode.ok && badCode.error === 'invalid invite code', 'bad code rejected');
  ok('non-existent invite code rejected');

  // Expired invite
  const expInviteCode = 'exp-inv-1';
  await store.set(`auth/invites/${expInviteCode}`, {
    code: expInviteCode,
    email: null,
    role: 'user',
    usedBy: null,
    usedAt: null,
    expiresAt: new Date(Date.now() - 3600_000).toISOString(), // expired
    createdAt: ts(),
  }, { mode: 'replace' });
  const expInvite = await register(store, {
    email: 'ivy@example.com',
    password: 'ivy-pass',
    name: 'Ivy',
    inviteCode: expInviteCode,
  });
  assert(!expInvite.ok && expInvite.error === 'invite expired', 'expired invite rejected');
  ok('expired invite rejected');

  // ──────────────────────────────────────────────────────────────
  // 7. Magic Links (passwordless login)
  // ──────────────────────────────────────────────────────────────
  section('7. Magic Links');

  // Send magic link for existing user
  const aliceMagic = await sendMagicLink(store, 'alice@example.com');
  assert(aliceMagic.ok, 'magic link created');
  assert(aliceMagic.data.token.length > 0, 'has token');
  ok(`magic link sent to alice: ${aliceMagic.data.token.slice(0, 8)}...`);

  // Verify magic link — creates session
  const aliceMagicVerify = await verifyMagicLink(store, aliceMagic.data.token, {
    userAgent: 'MagicLink/1.0',
    ip: '10.0.0.5',
  });
  assert(aliceMagicVerify.ok, 'magic link verified');
  assert(aliceMagicVerify.data.token.length > 0, 'session created');
  assert(aliceMagicVerify.data.user.email === 'alice@example.com', 'correct user');
  ok(`alice verified magic link, session: ${aliceMagicVerify.data.token.slice(0, 8)}...`);

  // Verify the session works
  const aliceMagicProfile = await getProfile(store, aliceMagicVerify.data.token);
  assert(aliceMagicProfile.ok, 'magic link session works for profile');
  ok('magic link session works for profile');

  // Check session has method: 'magic-link'
  const magicSession = unwrap(await store.get(`auth/sessions/${aliceMagicVerify.data.token}`));
  assert(magicSession.method === 'magic-link', 'session tracks auth method');
  ok('session tracks magic-link auth method');

  // Try to reuse the same magic link
  const aliceMagicReuse = await verifyMagicLink(store, aliceMagic.data.token);
  assert(!aliceMagicReuse.ok && aliceMagicReuse.error === 'magic link already used', 'reuse rejected');
  ok('magic link reuse rejected');

  // Magic link for NEW user (auto-registration)
  const newMagic = await sendMagicLink(store, 'newguy@example.com');
  assert(newMagic.ok, 'magic link for new user created');
  const newVerify = await verifyMagicLink(store, newMagic.data.token);
  assert(newVerify.ok, 'new user auto-created');
  assert(newVerify.data.isNewUser === true, 'flagged as new user');
  assert(newVerify.data.user.email === 'newguy@example.com', 'correct email');
  // Verify user was actually created in the store
  const newUserCheck = unwrap(await store.get('auth/users/newguy@example.com'));
  assert(newUserCheck !== null, 'user persisted in store');
  assert(newUserCheck.role === 'user', 'default role');
  ok(`new user auto-created via magic link: ${newVerify.data.user.email}`);

  // Invalid magic link token
  const badMagic = await verifyMagicLink(store, 'totally-fake-token');
  assert(!badMagic.ok && badMagic.error === 'invalid magic link', 'invalid token rejected');
  ok('invalid magic link token rejected');

  // Expired magic link
  const expMagicToken = 'expired-magic-test';
  await store.set(`auth/magic-links/${expMagicToken}`, {
    token: expMagicToken,
    email: 'someone@example.com',
    expiresAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
    createdAt: ts(),
    usedAt: null,
  }, { mode: 'replace' });
  const expMagicVerify = await verifyMagicLink(store, expMagicToken);
  assert(!expMagicVerify.ok && expMagicVerify.error === 'magic link expired', 'expired link rejected');
  ok('expired magic link rejected');

  // Magic link for suspended user
  const susMagic = await sendMagicLink(store, SUSPENDED.email);
  assert(susMagic.ok, 'magic link created (even for suspended)');
  const susVerify = await verifyMagicLink(store, susMagic.data.token);
  assert(!susVerify.ok && susVerify.error === 'account suspended', 'suspended user blocked');
  ok('magic link blocked for suspended user');

  // Empty email
  const emptyMagic = await sendMagicLink(store, '');
  assert(!emptyMagic.ok && emptyMagic.error === 'email required', 'empty email rejected');
  ok('magic link empty email rejected');

  // ──────────────────────────────────────────────────────────────
  // 8. Password Reset
  // ──────────────────────────────────────────────────────────────
  section('8. Password Reset');

  // Request reset for alice
  const aliceReset = await requestPasswordReset(store, 'alice@example.com');
  assert(aliceReset.ok, 'reset token created');
  ok(`password reset requested for alice: ${aliceReset.data.token.slice(0, 8)}...`);

  // Reset with new password
  const resetResult = await resetPassword(store, aliceReset.data.token, 'alice-NEW-pass');
  assert(resetResult.ok, 'password reset succeeded');
  ok('password reset succeeded');

  // Login with new password
  const aliceNewLogin = await login(store, { email: 'alice@example.com', password: 'alice-NEW-pass' });
  assert(aliceNewLogin.ok, 'login with new password works');
  ok('login with new password works');

  // Old password fails
  const aliceOldLogin = await login(store, { email: 'alice@example.com', password: DEMO_PASSWORD });
  assert(!aliceOldLogin.ok, 'old password fails after reset');
  ok('old password no longer works');

  // Reuse reset token
  const resetReuse = await resetPassword(store, aliceReset.data.token, 'another-pass');
  assert(!resetReuse.ok && resetReuse.error === 'reset token already used', 'reuse rejected');
  ok('reset token reuse rejected');

  // Expired reset token
  const expResetToken = 'exp-reset-1';
  await store.set(`auth/reset-tokens/${expResetToken}`, {
    token: expResetToken, email: 'alice@example.com',
    expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    createdAt: ts(), usedAt: null,
  }, { mode: 'replace' });
  const expReset = await resetPassword(store, expResetToken, 'new-pass');
  assert(!expReset.ok && expReset.error === 'reset token expired', 'expired token rejected');
  ok('expired reset token rejected');

  // Non-existent user
  const noUserReset = await requestPasswordReset(store, 'nobody@example.com');
  assert(!noUserReset.ok && noUserReset.error === 'user not found', 'missing user rejected');
  ok('password reset for non-existent user rejected');

  // ──────────────────────────────────────────────────────────────
  // 9. API Keys
  // ──────────────────────────────────────────────────────────────
  section('9. API Keys');

  // Admin creates API key
  const adminKey = await createApiKey(store, adminToken, { name: 'ci-pipeline' });
  assert(adminKey.ok, 'api key created');
  assert(adminKey.data.key.startsWith('sk_'), 'key has sk_ prefix');
  ok(`admin created api key: ${adminKey.data.key.slice(0, 16)}...`);

  // Validate API key
  const validateResult = await validateApiKey(store, adminKey.data.key);
  assert(validateResult.ok, 'api key validates');
  assert(validateResult.data.user.email === ADMIN.email, 'correct user');
  ok('api key validated successfully');

  // Alice creates her own key
  const aliceKey = await createApiKey(store, aliceNewLogin.data.token, {
    name: 'my-script',
    expiresInHours: 48,
  });
  assert(aliceKey.ok, 'alice created api key');
  ok(`alice created api key: ${aliceKey.data.key.slice(0, 16)}...`);

  // Revoke alice's key
  const revokeResult = await revokeApiKey(store, aliceNewLogin.data.token, aliceKey.data.key);
  assert(revokeResult.ok, 'api key revoked');
  ok('alice revoked her api key');

  // Revoked key fails validation
  const revokedValidate = await validateApiKey(store, aliceKey.data.key);
  assert(!revokedValidate.ok && revokedValidate.error === 'api key revoked', 'revoked key rejected');
  ok('revoked api key rejected');

  // Invalid key
  const badKey = await validateApiKey(store, 'sk_nonexistent');
  assert(!badKey.ok && badKey.error === 'invalid api key', 'invalid key rejected');
  ok('invalid api key rejected');

  // Expired key
  const expKeyId = 'sk_expired_test_key';
  await store.set(`auth/api-keys/${expKeyId}`, {
    key: expKeyId, email: ADMIN.email, name: 'expired-key',
    createdAt: ts(), expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    revokedAt: null, lastUsedAt: null,
  }, { mode: 'replace' });
  const expKeyResult = await validateApiKey(store, expKeyId);
  assert(!expKeyResult.ok && expKeyResult.error === 'api key expired', 'expired key rejected');
  ok('expired api key rejected');

  // Admin revokes another user's key
  const aliceKey2 = await createApiKey(store, aliceNewLogin.data.token, { name: 'temp-key' });
  const adminRevokeAlice = await revokeApiKey(store, adminToken, aliceKey2.data.key);
  assert(adminRevokeAlice.ok, 'admin can revoke other user keys');
  ok("admin revoked another user's key");

  // ──────────────────────────────────────────────────────────────
  // 10. Session Refresh / Rotation
  // ──────────────────────────────────────────────────────────────
  section('10. Session Refresh / Rotation');

  // Refresh (extend) admin session
  const refreshResult = await refreshSession(store, adminToken);
  assert(refreshResult.ok, 'session refreshed');
  assert(refreshResult.data.token === adminToken, 'same token on extend');
  ok('admin session extended in-place');

  // Rotate a session (new token)
  const rotateLogin = await login(store, { email: 'bob@example.com', password: DEMO_PASSWORD });
  assert(rotateLogin.ok, 'bob logged in for rotation test');
  const rotateResult = await refreshSession(store, rotateLogin.data.token, { rotate: true });
  assert(rotateResult.ok, 'session rotated');
  assert(rotateResult.data.token !== rotateLogin.data.token, 'new token issued');
  ok(`session rotated: ${rotateLogin.data.token.slice(0, 8)}... -> ${rotateResult.data.token.slice(0, 8)}...`);

  // Old token should be gone
  const oldTokenProfile = await getProfile(store, rotateLogin.data.token);
  assert(!oldTokenProfile.ok, 'old token invalid after rotation');
  ok('old token invalid after rotation');

  // New token works
  const newTokenProfile = await getProfile(store, rotateResult.data.token);
  assert(newTokenProfile.ok, 'rotated token works');
  ok('rotated token works');

  // Refresh expired session
  const expRefreshToken = 'exp-refresh-1';
  await store.set(`auth/sessions/${expRefreshToken}`, {
    token: expRefreshToken, email: ADMIN.email,
    expiresAt: new Date(Date.now() - 3600_000).toISOString(), createdAt: ts(),
  }, { mode: 'replace' });
  const expRefresh = await refreshSession(store, expRefreshToken);
  assert(!expRefresh.ok && expRefresh.error === 'session expired', 'expired refresh rejected');
  ok('refresh expired session rejected');

  // ──────────────────────────────────────────────────────────────
  // 11. Audit Log
  // ──────────────────────────────────────────────────────────────
  section('11. Audit Log');

  // Log a login event
  const auditResult = await auditLog(store, {
    action: 'login',
    email: ADMIN.email,
    detail: 'successful password login',
    ip: '127.0.0.1',
  });
  assert(auditResult.ok, 'audit entry created');
  assert(auditResult.data.id.length > 0, 'has id');
  ok('audit log entry created');

  // Log a failed login
  await auditLog(store, {
    action: 'login_failed',
    email: 'hacker@evil.com',
    detail: 'invalid password',
    ip: '203.0.113.99',
  });
  ok('failed login audit entry created');

  // Log a security event
  await auditLog(store, {
    action: 'password_reset',
    email: 'alice@example.com',
    detail: 'password changed via reset token',
  });
  ok('password reset audit entry created');

  // Query audit log
  const auditKeys = await store.keys('auth/audit-log');
  assert(auditKeys.length >= 3, 'audit log has entries');
  ok(`audit log: ${auditKeys.length} entries`);

  // ──────────────────────────────────────────────────────────────
  // 12. Email Verification
  // ──────────────────────────────────────────────────────────────
  section('12. Email Verification');

  // Send verification for alice
  const aliceVerifySend = await sendVerification(store, 'alice@example.com');
  assert(aliceVerifySend.ok, 'verification sent');
  ok(`verification token sent to alice`);

  // Verify alice's email
  const verifyResult = await verifyEmail(store, aliceVerifySend.data.token);
  assert(verifyResult.ok, 'email verified');
  assert(verifyResult.data.email === 'alice@example.com', 'correct email');
  ok('alice email verified');

  // Check user has emailVerified flag
  const aliceVerified = unwrap(await store.get('auth/users/alice@example.com'));
  assert(aliceVerified.emailVerified === true, 'emailVerified flag set');
  ok('emailVerified flag set on user');

  // Double verify
  const doubleVerify = await verifyEmail(store, aliceVerifySend.data.token);
  assert(!doubleVerify.ok && doubleVerify.error === 'already verified', 'double verify rejected');
  ok('double verification rejected');

  // Expired verification
  const expVerifyToken = 'exp-verify-1';
  await store.set(`auth/verify-tokens/${expVerifyToken}`, {
    token: expVerifyToken, email: 'alice@example.com',
    expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    createdAt: ts(), verifiedAt: null,
  }, { mode: 'replace' });
  const expVerify = await verifyEmail(store, expVerifyToken);
  assert(!expVerify.ok && expVerify.error === 'verification token expired', 'expired verify rejected');
  ok('expired verification token rejected');

  // Non-existent user
  const noUserVerify = await sendVerification(store, 'nobody@example.com');
  assert(!noUserVerify.ok && noUserVerify.error === 'user not found', 'missing user rejected');
  ok('verification for non-existent user rejected');

  // ──────────────────────────────────────────────────────────────
  // 13. Query & Search
  // ──────────────────────────────────────────────────────────────
  section('13. Query & Search');

  // List all user keys
  const userKeys = await store.keys('auth/users');
  assert(userKeys.length >= 7, 'should have 7+ users'); // admin, alice, bob, charlie, dave, frank, eve, newguy
  ok(`keys: ${userKeys.length} users`);

  // Search for a user by name
  const searchAlice = await store.search('auth/users', { type: 'bm25', query: 'Alice' });
  assert(searchAlice.length > 0, 'search finds Alice');
  ok(`search "Alice": ${searchAlice.length} result(s)`);

  // Query by role
  const admins = await store.query('auth/users', { filter: { role: { $eq: 'admin' } } });
  assert(admins.data.length === 1, 'one admin');
  ok(`query role=admin: ${admins.data.length}`);

  // Query by status
  const activeUsers = await store.query('auth/users', { filter: { status: { $eq: 'active' } } });
  ok(`query status=active: ${activeUsers.data.length} users`);

  const suspendedUsers = await store.query('auth/users', { filter: { status: { $eq: 'suspended' } } });
  assert(suspendedUsers.data.length === 1, 'one suspended');
  ok(`query status=suspended: ${suspendedUsers.data.length}`);

  // List sessions
  const sessionKeys = await store.keys('auth/sessions');
  ok(`active sessions: ${sessionKeys.length}`);

  // List invites
  const inviteKeys = await store.keys('auth/invites');
  ok(`invites: ${inviteKeys.length} total`);

  // ──────────────────────────────────────────────────────────────
  // 14. Edge Cases
  // ──────────────────────────────────────────────────────────────
  section('14. Edge Cases');

  // Unicode in user name
  const unicode = await register(store, {
    email: 'muller@example.com',
    password: DEMO_PASSWORD,
    name: 'M\u00fcller Stra\u00dfe',
  });
  assert(unicode.ok, 'unicode name accepted');
  const unicodeUser = unwrap(await store.get('auth/users/muller@example.com'));
  assert(unicodeUser.name === 'M\u00fcller Stra\u00dfe', 'unicode preserved');
  ok('unicode name preserved');

  // Long password
  const longPass = 'x'.repeat(1000);
  const longPassUser = await register(store, {
    email: 'long@example.com',
    password: longPass,
    name: 'Long Pass',
  });
  assert(longPassUser.ok, 'long password accepted');
  const longLogin = await login(store, { email: 'long@example.com', password: longPass });
  assert(longLogin.ok, 'long password login works');
  ok('1000-char password works');

  // Patch preserves passwordHash
  await store.patch('auth/users/alice@example.com', { name: 'Alice Smith-Jones' });
  const patched = unwrap(await store.get('auth/users/alice@example.com'));
  assert(patched.name === 'Alice Smith-Jones', 'name patched');
  assert(patched.passwordHash && patched.passwordHash.includes(':'), 'passwordHash preserved');
  // Verify she can still log in
  const alicePostPatch = await login(store, { email: 'alice@example.com', password: 'alice-NEW-pass' });
  assert(alicePostPatch.ok, 'login still works after patch');
  ok('patch preserves passwordHash');

  // Multiple sessions for same user
  const bobLogin1 = await login(store, { email: 'bob@example.com', password: DEMO_PASSWORD, userAgent: 'Chrome' });
  const bobLogin2 = await login(store, { email: 'bob@example.com', password: DEMO_PASSWORD, userAgent: 'Firefox' });
  assert(bobLogin1.ok && bobLogin2.ok, 'both logins succeed');
  assert(bobLogin1.data.token !== bobLogin2.data.token, 'different tokens');
  const bobProfile1 = await getProfile(store, bobLogin1.data.token);
  const bobProfile2 = await getProfile(store, bobLogin2.data.token);
  assert(bobProfile1.ok && bobProfile2.ok, 'both sessions valid');
  ok('multiple simultaneous sessions work');

  // Orphaned session (user deleted, session remains)
  await store.delete('auth/users/dave@example.com');
  const daveLogin = await login(store, { email: 'dave@example.com', password: 'dave-pass' });
  assert(!daveLogin.ok && daveLogin.error === 'user not found', 'deleted user cannot login');
  ok('deleted user cannot login');

  // ──────────────────────────────────────────────────────────────
  // 15. Summary
  // ──────────────────────────────────────────────────────────────
  section('15. Summary');

  const finalUsers = await store.keys('auth/users');
  const finalSessions = await store.keys('auth/sessions');
  const finalInvites = await store.keys('auth/invites');
  const finalMagicLinks = await store.keys('auth/magic-links');
  const finalResetTokens = await store.keys('auth/reset-tokens');
  const finalApiKeys = await store.keys('auth/api-keys');
  const finalAuditLog = await store.keys('auth/audit-log');
  const finalVerifyTokens = await store.keys('auth/verify-tokens');

  console.log(`\n  Users:          ${finalUsers.length}`);
  console.log(`  Sessions:       ${finalSessions.length}`);
  console.log(`  Invites:        ${finalInvites.length}`);
  console.log(`  Magic Links:    ${finalMagicLinks.length}`);
  console.log(`  Reset Tokens:   ${finalResetTokens.length}`);
  console.log(`  API Keys:       ${finalApiKeys.length}`);
  console.log(`  Audit Log:      ${finalAuditLog.length}`);
  console.log(`  Verify Tokens:  ${finalVerifyTokens.length}`);

  console.log(`\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
  console.log(`  All ${checkCount} checks passed!`);
  console.log(`  Data persists at: ${DATA_DIR}`);
  console.log(`\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n`);
}

main().catch((err) => {
  console.error(`\n\u2717 FAILED: ${err.message}`);
  console.error(err.stack);
  Deno.exit(1);
});
