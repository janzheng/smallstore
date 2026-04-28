/**
 * Tests for the env-var allowlist module — the layer that gates which env-var
 * names a peer's `auth.token_env` (or `value_env`, `user_env`, `pass_env`,
 * webhook `secret_env`) can resolve against the Worker env bag.
 *
 * Audit findings B002, B003, B010 — defense-in-depth so a peer registered
 * with `token_env: "SMALLSTORE_TOKEN"` can't exfiltrate the master token via
 * a hostile peer URL.
 */

import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  AllowlistViolationError,
  createEnvAllowlist,
  defaultEnvAllowlist,
} from '../src/peers/env-allowlist.ts';

Deno.test('default allowlist — accepts known platform prefixes', () => {
  for (const name of [
    'TF_TOKEN',
    'TF_API_KEY',
    'NOTION_TOKEN',
    'SHEET_KEY',
    'SHEETLOG_KEY',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'AIRTABLE_API_KEY',
    'UPSTASH_REDIS_REST_TOKEN',
    'API_KEY',
    'API_TOKEN',
    'WEBHOOK_SECRET',
    'BASIC_USER',
    'BASIC_PASS',
    'BEARER_TOKEN',
    'HMAC_SECRET',
  ]) {
    assertEquals(defaultEnvAllowlist.isAllowed(name), true, `expected ${name} to be allowed`);
  }
});

Deno.test('default allowlist — rejects reserved smallstore name (B002)', () => {
  assertEquals(defaultEnvAllowlist.isAllowed('SMALLSTORE_TOKEN'), false);
  assertEquals(defaultEnvAllowlist.isAllowed('SMALLSTORE_ANYTHING'), false);
});

Deno.test('default allowlist — rejects CF / AWS / DB / secret names', () => {
  for (const name of [
    'CLOUDFLARE_API_TOKEN',
    'CF_ACCOUNT_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'SECRET_KEY',
    'PRIVATE_KEY',
    'DATABASE_URL',
    'REDIS_URL',
  ]) {
    assertEquals(defaultEnvAllowlist.isAllowed(name), false, `expected ${name} to be rejected`);
  }
});

Deno.test('default allowlist — rejects generic shorthand', () => {
  for (const name of ['TOKEN', 'KEY', 'USER', 'PASS', 'TOK', 'K', 'V']) {
    assertEquals(defaultEnvAllowlist.isAllowed(name), false, `expected ${name} to be rejected`);
  }
});

Deno.test('default allowlist — rejects empty / non-string / lowercase / dashed', () => {
  assertEquals(defaultEnvAllowlist.isAllowed(''), false);
  assertEquals(defaultEnvAllowlist.isAllowed('tf_token'), false);
  assertEquals(defaultEnvAllowlist.isAllowed('TF-TOKEN'), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(defaultEnvAllowlist.isAllowed(undefined as any), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(defaultEnvAllowlist.isAllowed(null as any), false);
});

Deno.test('default allowlist — hardDeny wins over safePrefix', () => {
  // SMALLSTORE_TF_TOKEN matches both the hard-deny prefix (SMALLSTORE_) AND
  // would match the safe prefix (TF_) if hard-deny weren't checked first.
  // Hard-deny must always win.
  assertEquals(defaultEnvAllowlist.isAllowed('SMALLSTORE_TF_TOKEN'), false);
});

Deno.test('assert — throws AllowlistViolationError with name on .envName', () => {
  const err = assertThrows(
    () => defaultEnvAllowlist.assert('SMALLSTORE_TOKEN'),
    AllowlistViolationError,
  );
  assertEquals(err.envName, 'SMALLSTORE_TOKEN');
  // The Error.message must NOT include the env-var name (so callers can
  // surface .message to clients without leaking the name).
  assertEquals(err.message.includes('SMALLSTORE_TOKEN'), false);
});

Deno.test('reasonRejected — returns undefined for allowed, string for rejected', () => {
  assertEquals(defaultEnvAllowlist.reasonRejected('TF_TOKEN'), undefined);
  const reason = defaultEnvAllowlist.reasonRejected('SMALLSTORE_TOKEN');
  assertEquals(typeof reason, 'string');
  // Reason describes the policy without revealing the input name (caller
  // owns whether to include the name in surfaced errors).
  assertEquals(reason!.includes('SMALLSTORE_TOKEN'), false);
});

Deno.test('createEnvAllowlist — embedder can override safePrefix', () => {
  const al = createEnvAllowlist({ safePrefix: /^MYAPP_[A-Z0-9_]+$/ });
  assertEquals(al.isAllowed('MYAPP_TOKEN'), true);
  // Default safe prefix names no longer pass under the override
  assertEquals(al.isAllowed('TF_TOKEN'), false);
  // Hard-deny still applies (default kept)
  assertEquals(al.isAllowed('SMALLSTORE_TOKEN'), false);
});

Deno.test('createEnvAllowlist — embedder can override hardDeny', () => {
  // Pathological case: an embedder explicitly opting out of denylist.
  // Allowed in principle but they're now responsible for not letting
  // SMALLSTORE_* through. Test the override path works.
  const al = createEnvAllowlist({ hardDeny: /^NEVER_/ });
  assertEquals(al.isAllowed('SMALLSTORE_TOKEN'), false); // still rejected — fails default safePrefix
  assertEquals(al.isAllowed('TF_TOKEN'), true);
  assertEquals(al.isAllowed('NEVER_TOKEN'), false); // matches new hardDeny
});
