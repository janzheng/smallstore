// Minimal store interface and memory adapter for deploy-friendly builds.
// Avoids importing from ../../ which pulls in SQLite via transitive deps.

// deno-lint-ignore-file no-explicit-any

/** Minimal Smallstore interface — only what the interview engine needs */
export interface Smallstore {
  get(key: string): Promise<any>;
  set(key: string, value: unknown, options?: any): Promise<void>;
  delete(key: string): Promise<void>;
  has?(key: string): Promise<boolean>;
  keys?(prefix?: string): Promise<string[]>;
  clear?(prefix?: string): Promise<void>;
}

/** Simple in-memory store (used as fallback when no sheetlog URL is set) */
export class MemoryStore implements Smallstore {
  private data = new Map<string, unknown>();

  async get(key: string) {
    const v = this.data.get(key);
    return v !== undefined ? { content: v } : null;
  }
  async set(key: string, value: unknown) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async has(key: string) {
    return this.data.has(key);
  }
  async keys(prefix?: string) {
    const all = [...this.data.keys()];
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
  }
  async clear() {
    this.data.clear();
  }
}
