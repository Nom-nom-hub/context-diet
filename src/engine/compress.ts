/**
 * Synchronous compression engine core.
 *
 * Shared by the worker thread, the synchronous fallback path in
 * astParser.ts, the proxy and the unit tests. This module must NOT import
 * `vscode`, so it runs in plain Node.
 *
 * Fail-safe contract: if the Babel AST pipeline throws (malformed or
 * unsupported syntax), we silently degrade to the regex fallback — the
 * caller always gets compressed output, never an exception.
 */
import {
  transformWithBabel,
  CompressionLevel,
  TransformOptions,
} from './transformers/jsTsTransformer';
import { fallbackCompress } from './fallback';
import { countTokens } from './tokenizer';

export type { CompressionLevel };

export interface CompressOptions {
  level?: CompressionLevel;
  stripComments?: boolean;
  stripLogs?: boolean;
  filename?: string;
}

export interface CompressResult {
  code: string;
  level: CompressionLevel;
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  /** Integer percentage of tokens saved (0 when original is empty). */
  savedPercent: number;
  fallbackUsed: boolean;
  durationMs: number;
}

export const COMPRESSION_LEVELS: CompressionLevel[] = [
  'diet',
  'skeleton',
  'ultra-slim',
];

export function normalizeLevel(value: unknown): CompressionLevel {
  return value === 'diet' || value === 'ultra-slim' ? value : 'skeleton';
}

export function compressCode(
  code: string,
  options: CompressOptions = {},
): CompressResult {
  const started = Date.now();
  const level = normalizeLevel(options.level);
  const source = typeof code === 'string' ? code : String(code ?? '');
  const originalTokens = countTokens(source);

  let compressed: string;
  let fallbackUsed = false;
  try {
    const transformOptions: TransformOptions = {
      level,
      stripComments: options.stripComments,
      stripLogs: options.stripLogs,
      filename: options.filename,
    };
    compressed = transformWithBabel(source, transformOptions);
  } catch {
    fallbackUsed = true;
    compressed = fallbackCompress(source, {
      stripComments: options.stripComments,
      stripLogs: options.stripLogs,
    });
  }

  const compressedTokens = countTokens(compressed);
  const savedTokens = Math.max(0, originalTokens - compressedTokens);
  const savedPercent =
    originalTokens > 0
      ? Math.round((savedTokens / originalTokens) * 100)
      : 0;

  return {
    code: compressed,
    level,
    originalTokens,
    compressedTokens,
    savedTokens,
    savedPercent,
    fallbackUsed,
    durationMs: Date.now() - started,
  };
}
