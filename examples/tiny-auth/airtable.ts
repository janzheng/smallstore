#!/usr/bin/env -S deno run --allow-all
/**
 * Tiny Auth — Airtable Interactive CLI
 *
 * An interactive REPL to test auth operations against a real Airtable table.
 * Uses auto-field-creation so you only need an empty table to start.
 *
 * Setup:
 *   1. Create a table called "TinyAuth" in your Airtable base
 *   2. Set env vars: SM_AIRTABLE_API_KEY, SM_AIRTABLE_BASE_ID
 *   3. Optional: SM_AIRTABLE_AUTH_TABLE (defaults to "TinyAuth")
 *
 * Run: deno task auth:airtable
 */

// Load .env from project root
import { loadSync } from 'jsr:@std/dotenv';
try { loadSync({ envPath: new URL('../../.env', import.meta.url).pathname, export: true }); } catch { /* ok */ }

import {
  createSmallstore,
  createMemoryAdapter,
  createAirtableAdapter,
} from '../../mod.ts';

// ============================================================================
// Credential Check
// ============================================================================

const API_KEY = Deno.env.get('SM_AIRTABLE_API_KEY');
const BASE_ID = Deno.env.get('SM_AIRTABLE_BASE_ID');
const TABLE_NAME = Deno.env.get('SM_AIRTABLE_AUTH_TABLE') || 'TinyAuth';

if (!API_KEY || !BASE_ID || BASE_ID.startsWith('appXXX')) {
  console.log(`
  Airtable credentials missing. Add to .env:

    SM_AIRTABLE_API_KEY=pat...your-token...
    SM_AIRTABLE_BASE_ID=appYourBaseId
    SM_AIRTABLE_AUTH_TABLE=${TABLE_NAME}

  Then create a table called "${TABLE_NAME}" in your base.
  The adapter auto-creates fields — just need the default Name column.
`);
  Deno.exit(0);
}

// ============================================================================
// Helpers
// ============================================================================

function ts(): string { return new Date().toISOString(); }
function expiresIn(hours: number): string { return new Date(Date.now() + hours * 3600_000).toISOString(); }
function expiresInMinutes(minutes: number): string { return new Date(Date.now() + minutes * 60_000).toISOString(); }
function isExpired(isoDate: string): boolean { return new Date(isoDate).getTime() < Date.now(); }

function unwrap(result: any): any {
  if (result === null || result === undefined) return null;
  if (result.content !== undefined) {
    const c = result.content;
    if (Array.isArray(c) && c.length === 1) return c[0];
    return c;
  }
  return result;
}

function stripSensitive(user: any): any {
  if (!user) return user;
  const { passwordHash: _, ...safe } = user;
  return safe;
}

function pretty(obj: any): string {
  return JSON.stringify(obj, null, 2);
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

// ============================================================================
// Auth Functions
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
  const user = { email, name, role, status: 'active', passwordHash, emailVerified: false, createdAt: ts(), lastLoginAt: null };
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
  if (user.status !== 'active') return { ok: false, error: `account ${user.status}` };

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return { ok: false, error: 'invalid password' };

  const token = crypto.randomUUID();
  await store.set(`auth/sessions/${token}`, {
    token, email, expiresAt: expiresIn(24), createdAt: ts(),
    userAgent: userAgent || null, ip: ip || null, method: 'password',
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

async function logout(store: any, token: string) {
  const session = await store.get(`auth/sessions/${token}`);
  if (session === null || unwrap(session) === null) return { ok: false, error: 'session not found' };
  await store.delete(`auth/sessions/${token}`);
  return { ok: true };
}

async function createInvite(store: any, token: string, opts?: { email?: string; role?: string }) {
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

async function sendMagicLink(store: any, email: string) {
  if (!email) return { ok: false, error: 'email required' };
  const token = crypto.randomUUID();
  await store.set(`auth/magic-links/${token}`, {
    token, email, expiresAt: expiresInMinutes(15), createdAt: ts(), usedAt: null,
  }, { mode: 'replace' });
  return { ok: true, data: { token, email } };
}

async function verifyMagicLink(store: any, token: string, opts?: { userAgent?: string; ip?: string }) {
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
      status: 'active', passwordHash: placeholderHash, emailVerified: false, createdAt: ts(), lastLoginAt: null,
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

async function createApiKey(store: any, sessionToken: string, opts?: { name?: string; expiresInHours?: number }) {
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

async function refreshSession(store: any, token: string, opts?: { rotate?: boolean }) {
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

async function auditLog(store: any, event: { action: string; email?: string; detail?: string; ip?: string }) {
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const entry = { id, action: event.action, email: event.email || null, detail: event.detail || null, ip: event.ip || null, timestamp: ts() };
  await store.set(`auth/audit-log/${id}`, entry, { mode: 'replace' });
  return { ok: true, data: entry };
}

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
// CLI State
// ============================================================================

let currentToken: string | null = null;
let currentEmail: string | null = null;

function setSession(token: string, email: string) {
  currentToken = token;
  currentEmail = email;
}

function clearSession() {
  currentToken = null;
  currentEmail = null;
}

function requireToken(args: string[]): string | null {
  const token = args[0] || currentToken;
  if (!token) {
    console.log('  No active session. Login first or provide a token.');
    return null;
  }
  return token;
}

// ============================================================================
// CLI Output Helpers
// ============================================================================

function ok(msg: string) { console.log(`  + ${msg}`); }
function fail(msg: string) { console.log(`  ! ${msg}`); }
function info(msg: string) { console.log(`  ${msg}`); }

function showResult(result: any, label?: string) {
  if (result.ok) {
    ok(label || 'OK');
    if (result.data) info(pretty(result.data));
  } else {
    fail(result.error || 'Unknown error');
  }
}

// ============================================================================
// HELP
// ============================================================================

const HELP = `
  Auth Commands:
    register <email> <name...> <password>  Register (last arg = password)
    login <email> <password>               Login (saves session)
    logout                                 Logout current session
    me                                     View current profile
    whoami                                 Show current session info

  Passwordless:
    magic <email>                          Send magic link
    verify-magic <token>                   Verify magic link (auto-login)

  Password Reset:
    reset <email>                          Request password reset
    reset-confirm <token> <new-password>   Set new password

  API Keys:
    apikey [name]                          Create API key
    validate <api-key>                     Validate API key
    revoke <api-key>                       Revoke API key

  Sessions:
    refresh                                Extend current session
    rotate                                 Rotate to new token

  Email Verification:
    send-verify <email>                    Send verification email
    confirm-verify <token>                 Confirm email

  Admin:
    invite [email] [role]                  Create invite (admin only)
    audit <action> [detail]                Log audit event
    suspend <email>                        Suspend user
    activate <email>                       Activate user

  Data:
    users                                  List all users
    sessions                               List all sessions
    keys [prefix]                          List keys (e.g., "keys auth/invites")
    get <key>                              Get a record by key
    stats                                  Collection counts
    nuke                                   Delete ALL data
    seed                                   Create test seed data

  Other:
    help                                   This help
    quit / exit                            Exit
`;

// ============================================================================
// Seed Data
// ============================================================================

// Demo-only test password — NOT a real credential
const DEMO_PW = 'demo-only-not-a-real-password'; // pragma: allowlist secret

async function seedData(store: any) {
  console.log('\n  Seeding test data...');

  const adminHash = await hashPassword(DEMO_PW);
  await store.set('auth/users/admin@example.com', {
    email: 'admin@example.com', name: 'Admin User', role: 'admin', status: 'active',
    passwordHash: adminHash, emailVerified: true, createdAt: ts(), lastLoginAt: null,
  }, { mode: 'replace' });
  ok('admin@example.com seeded (role: admin)');

  const people = [
    { email: 'alice@example.com', name: 'Alice Smith' },
    { email: 'bob@example.com', name: 'Bob Johnson' },
    { email: 'charlie@example.com', name: 'Charlie Brown' },
  ];

  for (const p of people) {
    const r = await register(store, { ...p, password: DEMO_PW });
    if (r.ok) ok(`${p.email} registered`);
    else fail(`${p.email}: ${r.error}`);
  }

  // Suspend charlie
  await store.patch('auth/users/charlie@example.com', { status: 'suspended' });
  ok('charlie@example.com suspended');

  info('\n  Seed complete! Try: login admin@example.com');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`
  Tiny Auth -- Airtable CLI
  Base: ${BASE_ID}  |  Table: ${TABLE_NAME}
  Type "help" for commands, "seed" to create test data
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
    adapters: {
      airtable: airtableAdapter,
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'airtable',
    mounts: { 'cache/*': 'memory' },
  });

  while (true) {
    const statusBit = currentEmail ? ` [${currentEmail}]` : '';
    const raw = prompt(`tiny-auth${statusBit}>`);
    if (raw === null) break;
    if (!raw.trim()) continue;

    const parts = raw.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    try {
      switch (cmd) {
        // ── Auth ──────────────────────────────────────────
        case 'register': case 'reg': {
          if (args.length < 3) { info('Usage: register <email> <name...> <password>'); break; }
          const email = args[0];
          const password = args[args.length - 1];
          const name = args.slice(1, -1).join(' ');
          const r = await register(store, { email, password, name });
          showResult(r, `Registered ${email}`);
          break;
        }
        case 'login': {
          if (args.length < 2) { info('Usage: login <email> <password>'); break; }
          const r = await login(store, { email: args[0], password: args[1], userAgent: 'TinyAuth-CLI/1.0' });
          if (r.ok) {
            setSession(r.data.token, args[0]);
            ok(`Logged in as ${args[0]}`);
            info(`  Token: ${r.data.token}`);
          } else {
            fail(r.error!);
          }
          break;
        }
        case 'logout': {
          const token = requireToken(args);
          if (!token) break;
          const r = await logout(store, token);
          if (r.ok) {
            clearSession();
            ok('Logged out');
          } else fail(r.error!);
          break;
        }
        case 'me': case 'profile': {
          const token = requireToken(args);
          if (!token) break;
          const r = await getProfile(store, token);
          showResult(r, 'Profile');
          break;
        }
        case 'whoami': {
          if (currentToken) {
            info(`Email: ${currentEmail}`);
            info(`Token: ${currentToken}`);
          } else info('Not logged in');
          break;
        }

        // ── Passwordless ─────────────────────────────────
        case 'magic': {
          if (!args[0]) { info('Usage: magic <email>'); break; }
          const r = await sendMagicLink(store, args[0]);
          if (r.ok) {
            ok(`Magic link created for ${args[0]}`);
            info(`  Token: ${r.data.token}`);
            info(`  Use: verify-magic ${r.data.token}`);
          } else fail(r.error!);
          break;
        }
        case 'verify-magic': case 'vm': {
          if (!args[0]) { info('Usage: verify-magic <token>'); break; }
          const r = await verifyMagicLink(store, args[0], { userAgent: 'TinyAuth-CLI/1.0' });
          if (r.ok) {
            setSession(r.data.token, r.data.user.email);
            ok(`Logged in as ${r.data.user.email}${r.data.isNewUser ? ' (NEW user!)' : ''}`);
            info(`  Token: ${r.data.token}`);
          } else fail(r.error!);
          break;
        }

        // ── Password Reset ───────────────────────────────
        case 'reset': {
          if (!args[0]) { info('Usage: reset <email>'); break; }
          const r = await requestPasswordReset(store, args[0]);
          if (r.ok) {
            ok(`Reset token created for ${args[0]}`);
            info(`  Token: ${r.data.token}`);
            info(`  Use: reset-confirm ${r.data.token} <new-password>`);
          } else fail(r.error!);
          break;
        }
        case 'reset-confirm': case 'rc': {
          if (args.length < 2) { info('Usage: reset-confirm <token> <new-password>'); break; }
          const r = await resetPassword(store, args[0], args[1]);
          showResult(r, 'Password reset');
          break;
        }

        // ── API Keys ─────────────────────────────────────
        case 'apikey': case 'ak': {
          const token = requireToken([]);
          if (!token) break;
          const r = await createApiKey(store, token, { name: args[0] || 'cli-key', expiresInHours: 720 });
          if (r.ok) {
            ok(`API key created: ${r.data.key}`);
            info(`  Name: ${r.data.name}`);
          } else fail(r.error!);
          break;
        }
        case 'validate': case 'vk': {
          if (!args[0]) { info('Usage: validate <api-key>'); break; }
          const r = await validateApiKey(store, args[0]);
          showResult(r, 'API key valid');
          break;
        }
        case 'revoke': case 'rk': {
          if (!args[0]) { info('Usage: revoke <api-key>'); break; }
          const token = requireToken([]);
          if (!token) break;
          const r = await revokeApiKey(store, token, args[0]);
          showResult(r, 'API key revoked');
          break;
        }

        // ── Sessions ─────────────────────────────────────
        case 'refresh': {
          const token = requireToken(args);
          if (!token) break;
          const r = await refreshSession(store, token);
          showResult(r, 'Session refreshed');
          break;
        }
        case 'rotate': {
          const token = requireToken(args);
          if (!token) break;
          const r = await refreshSession(store, token, { rotate: true });
          if (r.ok) {
            setSession(r.data.token, currentEmail!);
            ok(`Session rotated`);
            info(`  New token: ${r.data.token}`);
          } else fail(r.error!);
          break;
        }

        // ── Email Verification ───────────────────────────
        case 'send-verify': case 'sv': {
          const email = args[0] || currentEmail;
          if (!email) { info('Usage: send-verify <email>'); break; }
          const r = await sendVerification(store, email);
          if (r.ok) {
            ok(`Verification sent to ${email}`);
            info(`  Token: ${r.data.token}`);
            info(`  Use: confirm-verify ${r.data.token}`);
          } else fail(r.error!);
          break;
        }
        case 'confirm-verify': case 'cv': {
          if (!args[0]) { info('Usage: confirm-verify <token>'); break; }
          const r = await verifyEmail(store, args[0]);
          showResult(r, 'Email verified');
          break;
        }

        // ── Admin ────────────────────────────────────────
        case 'invite': {
          const token = requireToken([]);
          if (!token) break;
          const r = await createInvite(store, token, { email: args[0], role: args[1] });
          if (r.ok) {
            ok(`Invite created: ${r.data.code}`);
            info(`  Use: register <email> <name> <password> (then use invite code at registration)`);
            info(pretty(r.data));
          } else fail(r.error!);
          break;
        }
        case 'audit': {
          if (!args[0]) { info('Usage: audit <action> [detail]'); break; }
          const r = await auditLog(store, { action: args[0], email: currentEmail || undefined, detail: args.slice(1).join(' ') || undefined });
          showResult(r, 'Audit logged');
          break;
        }
        case 'suspend': {
          if (!args[0]) { info('Usage: suspend <email>'); break; }
          await store.patch(`auth/users/${args[0]}`, { status: 'suspended' });
          ok(`${args[0]} suspended`);
          break;
        }
        case 'activate': {
          if (!args[0]) { info('Usage: activate <email>'); break; }
          await store.patch(`auth/users/${args[0]}`, { status: 'active' });
          ok(`${args[0]} activated`);
          break;
        }

        // ── Data ─────────────────────────────────────────
        case 'users': {
          const keys = await store.keys('auth/users');
          info(`${keys.length} users:`);
          for (const k of keys) {
            const fullKey = k.startsWith('auth/') ? k : `auth/${k}`;
            const u = unwrap(await store.get(fullKey));
            if (u) info(`  ${u.email || k}  (${u.role || '?'}, ${u.status || '?'})${u.emailVerified ? ' [verified]' : ''}`);
          }
          break;
        }
        case 'sessions': {
          const keys = await store.keys('auth/sessions');
          info(`${keys.length} sessions:`);
          for (const k of keys) {
            const fullKey = k.startsWith('auth/') ? k : `auth/${k}`;
            const s = unwrap(await store.get(fullKey));
            if (s) {
              const expired = s.expiresAt && isExpired(s.expiresAt) ? ' [EXPIRED]' : '';
              info(`  ${s.email || '?'}  method=${s.method || 'password'}  token=${(s.token || '?').slice(0, 8)}...${expired}`);
            }
          }
          break;
        }
        case 'keys': {
          const prefix = args[0] || 'auth/';
          const keys = await store.keys(prefix);
          info(`${keys.length} keys matching "${prefix}":`);
          for (const k of keys) info(`  ${k}`);
          break;
        }
        case 'get': case 'dump': {
          if (!args[0]) { info('Usage: get <key>'); break; }
          const data = unwrap(await store.get(args[0]));
          if (data) info(pretty(data));
          else fail(`Not found: ${args[0]}`);
          break;
        }
        case 'stats': {
          const collections = ['auth/users', 'auth/sessions', 'auth/invites', 'auth/magic-links', 'auth/reset-tokens', 'auth/api-keys', 'auth/audit-log', 'auth/verify-tokens'];
          info('Collection counts:');
          for (const col of collections) {
            const keys = await store.keys(col);
            const label = col.replace('auth/', '');
            info(`  ${label}: ${keys.length}`);
          }
          break;
        }
        case 'nuke': {
          const confirm = prompt('  Type "yes" to delete ALL auth data: ');
          if (confirm !== 'yes') { info('Cancelled.'); break; }
          const collections = ['auth/users', 'auth/sessions', 'auth/invites', 'auth/magic-links', 'auth/reset-tokens', 'auth/api-keys', 'auth/audit-log', 'auth/verify-tokens'];
          let total = 0;
          for (const col of collections) {
            const keys = await store.keys(col);
            for (const k of keys) {
              const fullKey = k.startsWith('auth/') ? k : `auth/${k}`;
              await store.delete(fullKey);
              total++;
            }
          }
          clearSession();
          ok(`Deleted ${total} records`);
          break;
        }
        case 'seed': {
          await seedData(store);
          break;
        }

        // ── Meta ─────────────────────────────────────────
        case 'help': case '?': {
          console.log(HELP);
          break;
        }
        case 'quit': case 'exit': case 'q': {
          console.log('  Bye!\n');
          Deno.exit(0);
        }
        default:
          info(`Unknown: "${cmd}". Type "help" for commands.`);
      }
    } catch (err: any) {
      fail(`${err.message}`);
    }
  }
}

main().catch(err => {
  console.error(`\nFailed: ${err.message}`);
  console.error(err);
  Deno.exit(1);
});
