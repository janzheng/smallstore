/**
 * In-memory inbox + channel registries.
 *
 * - **InboxRegistry**: holds Inbox instances by name. Mutable — populated from
 *   config at boot, mutated by `/admin/inboxes` at runtime. Same in-memory map
 *   either way.
 * - **ChannelRegistry**: holds Channel implementations by name. Channels
 *   self-register at module load time (`registerChannel(...)` in their `mod.ts`).
 *
 * No persistence here. Inboxes themselves persist their items through their
 * `StorageAdapter`; the registry only tracks "which inbox names are live in
 * this process" so HTTP routes can dispatch by name.
 *
 * TTL reaping (for runtime-created inboxes) lives at the registry level —
 * `prune()` walks entries past their TTL and removes them. Hosts can invoke
 * this from a setInterval (Deno) or DO alarm (CF Workers).
 */

import type { Channel, Inbox, InboxConfig } from './types.ts';

// ============================================================================
// Inbox registry
// ============================================================================

export interface InboxRegistration {
  inbox: Inbox;
  /** Original config used to create this inbox (for /admin/inboxes GET). */
  config: InboxConfig;
  /** Wall-clock ms when this inbox was registered (used by TTL reaper). */
  created_at: number;
  /** `boot` = from .smallstore.json; `runtime` = via admin API. */
  origin: 'boot' | 'runtime';
}

export class InboxRegistry {
  private entries = new Map<string, InboxRegistration>();

  /** Number of currently registered inboxes. */
  get size(): number {
    return this.entries.size;
  }

  /** Returns the inbox by name, or undefined. */
  get(name: string): Inbox | undefined {
    return this.entries.get(name)?.inbox;
  }

  /** Returns the full registration (inbox + config + metadata). */
  getRegistration(name: string): InboxRegistration | undefined {
    return this.entries.get(name);
  }

  /** Returns names of all registered inboxes (insertion order). */
  list(): string[] {
    return [...this.entries.keys()];
  }

  /** Returns full registrations (inbox + config + metadata) for all inboxes. */
  listRegistrations(): InboxRegistration[] {
    return [...this.entries.values()];
  }

  /**
   * Register an inbox. Throws if name already taken.
   *
   * @param name - logical inbox name (must match `inbox.name`)
   * @param inbox - the inbox instance
   * @param config - the config used to construct it
   * @param origin - 'boot' (from .smallstore.json) or 'runtime' (from admin API)
   */
  register(name: string, inbox: Inbox, config: InboxConfig, origin: 'boot' | 'runtime' = 'boot'): void {
    if (this.entries.has(name)) {
      throw new Error(`Inbox "${name}" already registered`);
    }
    this.entries.set(name, {
      inbox,
      config,
      created_at: Date.now(),
      origin,
    });
  }

  /** Unregister an inbox. Returns true if it existed. */
  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  /**
   * Reap runtime-created inboxes whose TTL has expired.
   *
   * Boot-time inboxes are NEVER pruned (no TTL by design — they're declared
   * config). Runtime inboxes without a TTL are also kept; only runtime + ttl
   * + expired entries get removed.
   *
   * Returns the names that were reaped.
   */
  prune(now: number = Date.now()): string[] {
    const removed: string[] = [];
    for (const [name, reg] of this.entries) {
      if (reg.origin !== 'runtime') continue;
      if (typeof reg.config.ttl !== 'number') continue;
      const expiresAt = reg.created_at + reg.config.ttl * 1000;
      if (now >= expiresAt) {
        this.entries.delete(name);
        removed.push(name);
      }
    }
    return removed;
  }

  /** Find the inbox configured for a given channel. Used by push-channel dispatch. */
  findByChannel(channel: string): InboxRegistration[] {
    const out: InboxRegistration[] = [];
    for (const reg of this.entries.values()) {
      if (reg.config.channel === channel) out.push(reg);
    }
    return out;
  }
}

// ============================================================================
// Channel registry
// ============================================================================

/**
 * Module-level registry of channel implementations. Channels self-register
 * by importing their module (e.g. `import './channels/cf-email.ts'` triggers
 * the `registerChannel(new CloudflareEmailChannel())` at the bottom of that file).
 */
const channels = new Map<string, Channel<any, any>>();

export function registerChannel(channel: Channel<any, any>): void {
  if (channels.has(channel.name)) {
    throw new Error(`Channel "${channel.name}" already registered`);
  }
  channels.set(channel.name, channel);
}

export function getChannel(name: string): Channel<any, any> | undefined {
  return channels.get(name);
}

export function listChannels(): Array<{ name: string; kind: 'push' | 'pull'; source: string }> {
  return [...channels.values()].map(c => ({ name: c.name, kind: c.kind, source: c.source }));
}

/** Test helper — clear all registered channels. Not exported from mod.ts. */
export function _resetChannelRegistry(): void {
  channels.clear();
}
