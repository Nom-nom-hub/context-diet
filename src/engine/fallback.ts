/**
 * Regex / scanner-based fail-safe fallback.
 *
 * Used when the Babel AST parser fails (malformed or unsupported syntax).
 * This path must never throw: it performs a character scan that strips
 * `//` and block comments while leaving string literals, template
 * literals and regex literals reasonably intact, removes standalone
 * `console.*(...)` statement lines, and collapses runs of blank lines.
 */

export interface FallbackOptions {
  stripComments?: boolean;
  stripLogs?: boolean;
}

const LOG_LINE =
  /^\s*console\.(log|debug|trace|info|warn|error)\s*\([\s\S]*\)\s*;?\s*$/;

/** Strip comments with a small state machine that respects strings. */
export function stripCommentsScanner(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  type State =
    | 'code'
    | 'single'
    | 'double'
    | 'template'
    | 'lineComment'
    | 'blockComment';
  let state: State = 'code';

  while (i < n) {
    const ch = code[i];
    const next = i + 1 < n ? code[i + 1] : '';

    switch (state) {
      case 'code': {
        if (ch === '/' && next === '/') {
          state = 'lineComment';
          i += 2;
          continue;
        }
        if (ch === '/' && next === '*') {
          state = 'blockComment';
          i += 2;
          continue;
        }
        if (ch === "'") {
          state = 'single';
        } else if (ch === '"') {
          state = 'double';
        } else if (ch === '`') {
          state = 'template';
        }
        out += ch;
        i += 1;
        continue;
      }
      case 'single':
      case 'double': {
        const quote = state === 'single' ? "'" : '"';
        out += ch;
        if (ch === '\\') {
          if (next) {
            out += next;
            i += 2;
            continue;
          }
        } else if (ch === quote || ch === '\n') {
          state = 'code';
        }
        i += 1;
        continue;
      }
      case 'template': {
        out += ch;
        if (ch === '\\') {
          if (next) {
            out += next;
            i += 2;
            continue;
          }
        } else if (ch === '`') {
          state = 'code';
        }
        i += 1;
        continue;
      }
      case 'lineComment': {
        if (ch === '\n') {
          out += ch;
          state = 'code';
        }
        i += 1;
        continue;
      }
      case 'blockComment': {
        if (ch === '*' && next === '/') {
          state = 'code';
          i += 2;
          continue;
        }
        if (ch === '\n') {
          out += ch;
        }
        i += 1;
        continue;
      }
    }
  }
  return out;
}

/**
 * Compress code without an AST. Never throws.
 */
export function fallbackCompress(
  code: string,
  options: FallbackOptions = {},
): string {
  try {
    const stripComments = options.stripComments !== false;
    const stripLogs = options.stripLogs !== false;

    let text = typeof code === 'string' ? code : String(code ?? '');
    if (stripComments) {
      text = stripCommentsScanner(text);
    }
    let lines = text.split('\n');
    if (stripLogs) {
      lines = lines.filter((line) => !LOG_LINE.test(line));
    }
    // Collapse 2+ consecutive blank lines into a single blank line and
    // trim trailing whitespace per line.
    const collapsed: string[] = [];
    let blankRun = 0;
    for (const raw of lines) {
      const line = raw.replace(/[ \t]+$/g, '');
      if (line.trim() === '') {
        blankRun += 1;
        if (blankRun <= 1) {
          collapsed.push('');
        }
      } else {
        blankRun = 0;
        collapsed.push(line);
      }
    }
    return collapsed.join('\n').trim();
  } catch {
    // Absolute last resort: return the input untouched rather than throw.
    return typeof code === 'string' ? code : '';
  }
}
