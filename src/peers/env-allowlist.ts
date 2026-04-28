/**
 * Env-var name allowlist — gates which env-var names a peer's `auth.token_env`
 * (or `value_env`, `user_env`, `pass_env`, webhook `secret_env`) can resolve
 * against the Worker's env bag.
 *
 * Why this exists: peer registration takes user-supplied strings as env-var
 * names and the resolver looks them up directly via `env[name]`. Without a
 * gate, a peer registered with `token_env: "SMALLSTORE_TOKEN"` + a hostile URL
 * exfiltrates the master bearer token on every proxy fetch. Today peer
 * registration requires the master token (= already-root), so this is
 * defense-in-depth — but the docstrings imply a safety the code didn't
 * enforce. See audit findings B002, B003, B010.
 *
 * Policy:
 *   1. **Hard-deny first** — names matching `hardDeny` are blocked even if
 *      they would otherwise match `safePrefix`. This is the layer that stops
 *      `SMALLSTORE_TOKEN`, `CLOUDFLARE_*`, `CF_*`, `AWS_*` from being used
 *      as auth refs no matter what the operator sets.
 *   2. **Safe-prefix second** — names must additionally match `safePrefix`
 *      to be allowed. Default prefix matches common platform tokens
 *      (`TF_*`, `NOTION_*`, etc.).
 *
 * Embedders can override either pattern via `createEnvAllowlist({ ... })`.
 * The default singleton (`defaultEnvAllowlist`) is what `resolvePeerAuth`
 * uses out of the box; deploy code uses the same default for HMAC secret
 * resolution.
 */

/**
 * Default safe-prefix — names must match this AND not match `hardDeny`.
 *
 * Allows known platform-token prefixes. Extend (via `createEnvAllowlist`) for
 * deployments that integrate additional services. The trailing `[A-Z0-9_]+`
 * forces uppercase + underscore-delimited names so values like `tf_token`
 * (lowercase) or `TF-TOKEN` (dash) don't accidentally pass.
 *
 * Prefixes included by default:
 *   - `TF_*`        — tigerflare
 *   - `NOTION_*`    — Notion API
 *   - `SHEET_*` / `SHEETLOG_*` — Google Sheets / smallstore's sheetlog adapter
 *   - `GH_*` / `GITHUB_*` — GitHub
 *   - `AIRTABLE_*`  — Airtable
 *   - `UPSTASH_*`   — Upstash Redis
 *   - `API_*`       — generic API tokens
 *   - `WEBHOOK_*`   — webhook HMAC secrets
 *   - `BASIC_*` / `BEARER_*` / `HMAC_*` — auth-shape-named secrets
 */
const DEFAULT_SAFE_PREFIX = /^(TF_|NOTION_|SHEET_|SHEETLOG_|GH_|GITHUB_|AIRTABLE_|UPSTASH_|API_|WEBHOOK_|BASIC_|BEARER_|HMAC_)[A-Z0-9_]+$/;

/**
 * Default hard-deny — names matching this are always blocked, regardless
 * of `safePrefix`. Defense-in-depth against accidental allowlist drift.
 *
 * - `SMALLSTORE_*` — the master bearer token + any future smallstore secret
 * - `CLOUDFLARE_` / `CF_` — Workers / D1 / R2 / KV credentials
 * - `AWS_*` — S3-compatible secret access keys
 * - `SECRET_*` / `PRIVATE_*` — generic secret-flavored names
 * - `DATABASE_` / `REDIS_` — connection strings (often contain credentials)
 */
const DEFAULT_HARD_DENY = /^(SMALLSTORE_|CLOUDFLARE_|CF_|AWS_|SECRET_|PRIVATE_|DATABASE_|REDIS_)/;

export interface EnvAllowlist {
  /** Returns true iff the name is permitted. Never throws. */
  isAllowed(name: string): boolean;
  /** Throws `AllowlistViolationError` if the name is not permitted. */
  assert(name: string): void;
  /**
   * Human-readable rejection reason, or undefined if allowed. Useful for
   * shape validators that surface error messages to the caller (without
   * leaking the env var name itself — caller is responsible for that).
   */
  reasonRejected(name: string): string | undefined;
}

export interface EnvAllowlistOptions {
  /** Override the default safe-prefix regex. */
  safePrefix?: RegExp;
  /** Override the default hard-deny regex. */
  hardDeny?: RegExp;
}

export class AllowlistViolationError extends Error {
  constructor(
    public readonly envName: string,
    public readonly reason: string,
  ) {
    // Keep the env-var name out of the message body — callers may surface
    // `.message` to unauthenticated clients. The name is on `.envName` for
    // server-side logging.
    super(`env var name not allowed: ${reason}`);
    this.name = 'AllowlistViolationError';
  }
}

export function createEnvAllowlist(opts: EnvAllowlistOptions = {}): EnvAllowlist {
  const safe = opts.safePrefix ?? DEFAULT_SAFE_PREFIX;
  const deny = opts.hardDeny ?? DEFAULT_HARD_DENY;

  const reasonRejected = (name: string): string | undefined => {
    if (typeof name !== 'string' || !name) {
      return 'must be a non-empty string';
    }
    if (deny.test(name)) {
      return 'matches a reserved prefix (smallstore/CF/AWS/secret/database/redis)';
    }
    if (!safe.test(name)) {
      return 'does not match an allowed prefix (TF_/NOTION_/SHEET_/GH_/AIRTABLE_/UPSTASH_/API_/WEBHOOK_)';
    }
    return undefined;
  };

  return {
    isAllowed(name: string) {
      return reasonRejected(name) === undefined;
    },
    assert(name: string) {
      const reason = reasonRejected(name);
      if (reason !== undefined) {
        throw new AllowlistViolationError(name, reason);
      }
    },
    reasonRejected,
  };
}

/**
 * Default singleton — used by `resolvePeerAuth` and the deploy's
 * `resolveHmacSecret`. Embedders that need a custom policy can construct
 * their own via `createEnvAllowlist({ ... })` and route their callers
 * through that instance instead.
 */
export const defaultEnvAllowlist: EnvAllowlist = createEnvAllowlist();
