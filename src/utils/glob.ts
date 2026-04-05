// Glob Pattern Matching Utility
//
// Converts shell-like glob patterns to RegExp for key matching.
//
// Supported patterns:
//   *      — matches any characters except /
//   **     — matches any characters including /
//   ?      — matches exactly one character (not /)
//   {a,b}  — matches either a or b

/**
 * Check if a string contains glob pattern characters.
 */
export function isGlobPattern(str: string): boolean {
  return /[*?{]/.test(str);
}

// Convert a glob pattern to a RegExp.
// Escapes regex-special characters, then replaces glob tokens:
//   ** → .* (match everything including separators)
//   *  → [^/]* (match within one segment)
//   ?  → [^/] (match one non-separator char)
//   {a,b,c} → (?:a|b|c) (alternation)
export function globToRegex(pattern: string): RegExp {
  // First handle {a,b} alternation groups before escaping
  let result = '';
  let i = 0;

  while (i < pattern.length) {
    if (pattern[i] === '{') {
      // Find matching close brace
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        // No matching brace, treat as literal
        result += '\\{';
        i++;
        continue;
      }
      const alternatives = pattern.slice(i + 1, close).split(',');
      const escaped = alternatives.map((alt) => escapeForRegex(alt));
      result += `(?:${escaped.join('|')})`;
      i = close + 1;
    } else if (pattern[i] === '*') {
      if (pattern[i + 1] === '*') {
        // ** — match everything (including /)
        result += '.*';
        i += 2;
        // Skip trailing / after ** (e.g., **/ is same as **)
        if (pattern[i] === '/') i++;
      } else {
        // * — match within one segment (no /)
        result += '[^/]*';
        i++;
      }
    } else if (pattern[i] === '?') {
      result += '[^/]';
      i++;
    } else {
      result += escapeForRegex(pattern[i]);
      i++;
    }
  }

  return new RegExp(`^${result}$`);
}

/**
 * Test if a key matches a glob pattern.
 */
export function matchGlob(key: string, pattern: string): boolean {
  return globToRegex(pattern).test(key);
}

/**
 * Extract the static prefix before the first glob character.
 * Used to narrow down adapter keys() calls before post-filtering.
 *
 * When the pattern starts with a glob character (e.g., "*", "**\/"),
 * returns an empty string — callers should expect a full scan in that case.
 */
export function extractStaticPrefix(pattern: string): string {
  const firstGlob = pattern.search(/[*?{]/);
  if (firstGlob === -1) return pattern;
  return pattern.slice(0, firstGlob);
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Escape a single character for use in a regex.
 */
function escapeForRegex(str: string): string {
  return str.replace(/[.+^$|\\()[\]]/g, '\\$&');
}
