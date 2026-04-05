/**
 * CLI Helpers — store creation and output formatting
 */

import { createSmallstore } from '../../mod.ts';
import type { PresetName } from '../../presets.ts';
import type { Smallstore } from '../../src/types.ts';

export interface CliOptions {
  preset: PresetName;
  json: boolean;
  config?: string;
}

/** Parse global CLI flags from Deno.args */
export function parseGlobalFlags(args: string[]): { flags: CliOptions; rest: string[] } {
  let preset: PresetName = 'local-sqlite';
  let json = false;
  let config: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--preset=')) {
      preset = arg.split('=')[1] as PresetName;
    } else if (arg === '--preset' && i + 1 < args.length) {
      preset = args[++i] as PresetName;
    } else if (arg.startsWith('--config=')) {
      config = arg.split('=')[1];
    } else if (arg === '--config' && i + 1 < args.length) {
      config = args[++i];
    } else if (arg === '--json') {
      json = true;
    } else {
      rest.push(arg);
    }
  }

  return { flags: { preset, json, config }, rest };
}

/** Create a smallstore instance from CLI flags */
export function createStore(flags: CliOptions): Smallstore {
  return createSmallstore({ preset: flags.preset });
}

/** Print output — JSON if --json, otherwise formatted */
export function output(data: unknown, flags: CliOptions): void {
  if (flags.json || typeof data !== 'string') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

/** Print an error and exit */
export function fail(message: string): never {
  console.error(`Error: ${message}`);
  Deno.exit(1);
}

/** Try to parse JSON from a string, or read from @file path */
export async function parseJsonArg(arg: string): Promise<unknown> {
  if (arg.startsWith('@')) {
    const filePath = arg.slice(1);
    try {
      const text = await Deno.readTextFile(filePath);
      return JSON.parse(text);
    } catch (e) {
      fail(`Could not read file "${filePath}": ${(e as Error).message}`);
    }
  }

  try {
    return JSON.parse(arg);
  } catch {
    // Treat as plain string value
    return arg;
  }
}
