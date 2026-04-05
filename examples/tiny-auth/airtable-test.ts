#!/usr/bin/env -S deno run --allow-all
/**
 * Tiny Auth — Airtable Live Test (non-interactive)
 *
 * Runs the same auth operations as the REPL but as an automated script.
 * Run: deno run --allow-all examples/tiny-auth/airtable-test.ts
 */

import { loadSync } from 'jsr:@std/dotenv';
try { loadSync({ envPath: new URL('../../.env', import.meta.url).pathname, export: true }); } catch { /* ok */ }

// Demo-only test password — NOT a real credential
const DEMO_PW = 'demo-only-not-a-real-password'; // pragma: allowlist secret

import {
  createSmallstore,
  createMemoryAdapter,
  createAirtableAdapter,
} from '../../mod.ts';

const API_KEY = Deno.env.get('SM_AIRTABLE_API_KEY');
const BASE_ID = Deno.env.get('SM_AIRTABLE_BASE_ID');
const TABLE_NAME = Deno.env.get('SM_AIRTABLE_AUTH_TABLE') || 'TinyAuth';

if (!API_KEY || !BASE_ID || BASE_ID.startsWith('appXXX')) {
  console.log('Missing Airtable credentials. Set SM_AIRTABLE_API_KEY + SM_AIRTABLE_BASE_ID in .env');
  Deno.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(msg: string) { console.log(`  ✅ ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }
function ts() { return new Date().toISOString(); }
function expiresIn(hours: number) { return new Date(Date.now() + hours * 3600_000).toISOString(); }
function isExpired(d: string) { return new Date(d) < new Date(); }

async function hashPassword(password: string, salt?: string): Promise<string> {
  const s = salt || crypto.randomUUID();
  const data = new TextEncoder().encode(s + password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${s}:${hex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt] = stored.split(':');
  const rehash = await hashPassword(password, salt);
  return rehash === stored;
}

function unwrap(result: any) {
  if (!result) return null;
  if (result?.content) {
    if (Array.isArray(result.content)) return result.content.length === 1 ? result.content[0] : result.content;
    return result.content;
  }
  return result;
}

function stripSensitive(user: any) {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
}

// ── Auth Functions (same as mod.ts) ──────────────────────────────────────────

async function register(store: any, { email, password, name, inviteCode }: any) {
  if (!email || !password) return { ok: false, error: 'Email and password required' };
  const existing = unwrap(await store.get(`auth/users/${email}`));
  if (existing) return { ok: false, error: 'Email already registered' };
  if (inviteCode) {
    const invite = unwrap(await store.get(`auth/invites/${inviteCode}`));
    if (!invite) return { ok: false, error: 'Invalid invite code' };
    if (invite.usedBy) return { ok: false, error: 'Invite already used' };
    if (invite.expiresAt && isExpired(invite.expiresAt)) return { ok: false, error: 'Invite expired' };
    if (invite.email && invite.email !== email) return { ok: false, error: 'Invite is for a different email' };
    await store.patch(`auth/invites/${inviteCode}`, { usedBy: email, usedAt: ts() });
  }
  const passwordHash = await hashPassword(password);
  const user = {
    email, displayName: name || email.split('@')[0], role: 'user', status: 'active',
    passwordHash, emailVerified: false, createdAt: ts(), lastLoginAt: null,
  };
  await store.set(`auth/users/${email}`, user, { mode: 'replace' });
  return { ok: true, data: stripSensitive(user) };
}

async function login(store: any, { email, password }: any) {
  const user = unwrap(await store.get(`auth/users/${email}`));
  if (!user) return { ok: false, error: 'Invalid credentials' };
  if (user.status === 'suspended') return { ok: false, error: 'Account suspended' };
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return { ok: false, error: 'Invalid credentials' };
  const token = crypto.randomUUID();
  const session = { token, email, createdAt: ts(), expiresAt: expiresIn(24), userAgent: 'airtable-test' };
  await store.set(`auth/sessions/${token}`, session, { mode: 'replace' });
  await store.patch(`auth/users/${email}`, { lastLoginAt: ts() });
  return { ok: true, data: { token, user: stripSensitive(user) } };
}

async function getProfile(store: any, token: string) {
  const session = unwrap(await store.get(`auth/sessions/${token}`));
  if (!session) return { ok: false, error: 'Invalid session' };
  if (session.expiresAt && isExpired(session.expiresAt)) return { ok: false, error: 'Session expired' };
  const user = unwrap(await store.get(`auth/users/${session.email}`));
  if (!user) return { ok: false, error: 'User not found' };
  return { ok: true, data: stripSensitive(user) };
}

async function logout(store: any, token: string) {
  const session = unwrap(await store.get(`auth/sessions/${token}`));
  if (!session) return { ok: false, error: 'Session not found' };
  await store.delete(`auth/sessions/${token}`);
  return { ok: true };
}

async function createInvite(store: any, token: string, { email, role }: any = {}) {
  const profile = await getProfile(store, token);
  if (!profile.ok) return profile;
  if (profile.data.role !== 'admin') return { ok: false, error: 'Admin only' };
  const code = crypto.randomUUID().slice(0, 8);
  const invite = {
    code, createdBy: profile.data.email, email: email || null,
    role: role || 'user', createdAt: ts(), expiresAt: expiresIn(72), usedBy: null,
  };
  await store.set(`auth/invites/${code}`, invite, { mode: 'replace' });
  return { ok: true, data: invite };
}

// ── Main Test ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║  Tiny Auth — Airtable Live Test                                ║
║  Base: ${BASE_ID}                                    ║
║  Table: ${TABLE_NAME}                                          ║
╚════════════════════════════════════════════════════════════════╝
`);

  const airtableAdapter = createAirtableAdapter({
    apiKey: API_KEY!,
    baseId: BASE_ID!,
    tableIdOrName: TABLE_NAME,
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
    timeout: 60000,
  });

  const store = createSmallstore({
    adapters: { airtable: airtableAdapter, memory: createMemoryAdapter() },
    defaultAdapter: 'airtable',
    mounts: { 'cache/*': 'memory' },
  });

  let passed = 0;
  let failed_count = 0;
  function check(condition: boolean, msg: string) {
    if (condition) { ok(msg); passed++; }
    else { fail(msg); failed_count++; }
  }

  // ── 1. Seed ────────────────────────────────────────────────────────────────
  console.log('\n── 1. Seed Data ──');

  const adminHash = await hashPassword(DEMO_PW);
  await store.set('auth/users/admin@example.com', {
    email: 'admin@example.com', displayName: 'Admin User', role: 'admin', status: 'active',
    passwordHash: adminHash, emailVerified: true, createdAt: ts(), lastLoginAt: null,
  }, { mode: 'replace' });
  ok('Seeded admin (admin@example.com)');

  const r1 = await register(store, { email: 'alice@test.com', password: DEMO_PW, name: 'Alice Smith' });
  check(r1.ok, `Registered alice@test.com`);

  const r2 = await register(store, { email: 'bob@test.com', password: DEMO_PW, name: 'Bob Johnson' });
  check(r2.ok, `Registered bob@test.com`);

  // ── 2. Login ───────────────────────────────────────────────────────────────
  console.log('\n── 2. Login Flows ──');

  const adminLogin = await login(store, { email: 'admin@example.com', password: DEMO_PW });
  check(adminLogin.ok, `Admin login → token: ${adminLogin.data?.token?.slice(0, 8)}...`);

  const aliceLogin = await login(store, { email: 'alice@test.com', password: DEMO_PW });
  check(aliceLogin.ok, `Alice login → token: ${aliceLogin.data?.token?.slice(0, 8)}...`);

  const badLogin = await login(store, { email: 'alice@test.com', password: 'wrong' });
  check(!badLogin.ok, `Wrong password rejected: ${badLogin.error}`);

  const ghostLogin = await login(store, { email: 'ghost@nowhere.com', password: 'abc' });
  check(!ghostLogin.ok, `Non-existent user rejected: ${ghostLogin.error}`);

  // ── 3. Profile ─────────────────────────────────────────────────────────────
  console.log('\n── 3. Profile Access ──');

  const adminProfile = await getProfile(store, adminLogin.data.token);
  check(adminProfile.ok && adminProfile.data.role === 'admin', `Admin profile: role=${adminProfile.data?.role}`);
  check(!adminProfile.data?.passwordHash, 'No passwordHash in response');

  const aliceProfile = await getProfile(store, aliceLogin.data.token);
  check(aliceProfile.ok && aliceProfile.data.displayName === 'Alice Smith', `Alice profile: displayName=${aliceProfile.data?.displayName}`);

  const badProfile = await getProfile(store, 'fake-token-123');
  check(!badProfile.ok, `Invalid token rejected: ${badProfile.error}`);

  // ── 4. Invites ─────────────────────────────────────────────────────────────
  console.log('\n── 4. Invite System ──');

  const inv = await createInvite(store, adminLogin.data.token, { role: 'user' });
  check(inv.ok, `Admin created invite: ${inv.data?.code}`);

  const aliceInv = await createInvite(store, aliceLogin.data.token, {});
  check(!aliceInv.ok, `Non-admin invite rejected: ${aliceInv.error}`);

  // Register with invite
  if (inv.ok) {
    const r3 = await register(store, { email: 'carol@test.com', password: DEMO_PW, name: 'Carol', inviteCode: inv.data.code });
    check(r3.ok, `Carol registered with invite code ${inv.data.code}`);

    // Reuse should fail
    const r4 = await register(store, { email: 'dave@test.com', password: DEMO_PW, inviteCode: inv.data.code });
    check(!r4.ok, `Invite reuse rejected: ${r4.error}`);
  }

  // ── 5. Logout ──────────────────────────────────────────────────────────────
  console.log('\n── 5. Logout ──');

  const logoutResult = await logout(store, aliceLogin.data.token);
  check(logoutResult.ok, 'Alice logged out');

  const postLogout = await getProfile(store, aliceLogin.data.token);
  check(!postLogout.ok, `Post-logout profile fails: ${postLogout.error}`);

  // ── 6. Edge Cases ──────────────────────────────────────────────────────────
  console.log('\n── 6. Edge Cases ──');

  const dup = await register(store, { email: 'alice@test.com', password: 'whatever' });
  check(!dup.ok, `Duplicate email rejected: ${dup.error}`);

  const emptyPass = await register(store, { email: 'new@test.com', password: '' });
  check(!emptyPass.ok, `Empty password rejected: ${emptyPass.error}`);

  // ── 7. Data Inspection ─────────────────────────────────────────────────────
  console.log('\n── 7. Data Inspection ──');

  const userKeys = await store.keys('auth/users');
  info(`User keys: ${JSON.stringify(userKeys)}`);
  check(Array.isArray(userKeys) && userKeys.length >= 3, `Found ${userKeys.length} users`);

  const sessionKeys = await store.keys('auth/sessions');
  info(`Session keys: ${JSON.stringify(sessionKeys)}`);

  const inviteKeys = await store.keys('auth/invites');
  info(`Invite keys: ${JSON.stringify(inviteKeys)}`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║  Results: ${passed} passed, ${failed_count} failed                              ║
║  Check your Airtable: https://airtable.com/${BASE_ID}  ║
╚════════════════════════════════════════════════════════════════╝
`);

  if (failed_count > 0) Deno.exit(1);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
