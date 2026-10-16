/**
 * Token counting for ContextDiet.
 *
 * Primary path: `gpt-tokenizer` (a pure-JS port of OpenAI's tiktoken BPE
 * encoder, cl100k_base). It is loaded lazily via `require` inside a
 * try/catch so that a missing / incompatible install can never crash the
 * extension host.
 *
 * Fallback path: a documented approximation. BPE tokenizers split code
 * roughly on word boundaries and individual punctuation/symbols, so we
 * count runs of word characters as ~1 token per 4 characters (rounded up)
 * plus one token per punctuation/symbol character. This tracks cl100k
 * counts for typical TS/JS source within roughly ±15% and is only used
 * when the real encoder is unavailable.
 */

type EncodeFn = (text: string) => unknown[];

let cachedEncoder: EncodeFn | null | undefined;
let encoderLoadAttempted = false;

function loadEncoder(): EncodeFn | null {
  if (encoderLoadAttempted) {
    return cachedEncoder ?? null;
  }
  encoderLoadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('gpt-tokenizer') as {
      encode?: EncodeFn;
      default?: { encode?: EncodeFn };
    };
    const fn = mod.encode ?? mod.default?.encode;
    if (typeof fn === 'function') {
      // Smoke-test it: some ESM-only builds load but throw on use.
      const probe = fn('hello world');
      if (Array.isArray(probe) && probe.length > 0) {
        cachedEncoder = fn;
        return cachedEncoder;
      }
    }
  } catch {
    // fall through to js-tiktoken
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('js-tiktoken') as {
      getEncoding?: (name: string) => { encode: EncodeFn };
      encodingForModel?: (name: string) => { encode: EncodeFn };
    };
    const enc = mod.getEncoding
      ? mod.getEncoding('cl100k_base')
      : mod.encodingForModel
        ? mod.encodingForModel('gpt-4o')
        : undefined;
    if (enc && typeof enc.encode === 'function') {
      cachedEncoder = enc.encode.bind(enc);
      return cachedEncoder;
    }
  } catch {
    // fall through to approximation
  }
  cachedEncoder = null;
  return null;
}

/** Approximate token count used only when no real BPE encoder is available. */
export function approximateCountTokens(text: string): number {
  if (!text) {
    return 0;
  }
  let count = 0;
  const pattern = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[0];
    if (/^[A-Za-z0-9_]+$/.test(token)) {
      count += Math.max(1, Math.ceil(token.length / 4));
    } else {
      count += 1;
    }
  }
  return count;
}

/** Count tokens in `text`. Empty string is always 0. Never throws. */
export function countTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const encoder = loadEncoder();
  if (encoder) {
    try {
      return encoder(text).length;
    } catch {
      // fall through to approximation
    }
  }
  return approximateCountTokens(text);
}
