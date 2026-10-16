/**
 * Local HTTP proxy interceptor.
 *
 * Listens on 127.0.0.1 (default port 8765). Point any OpenAI- or
 * Anthropic-compatible client at `http://127.0.0.1:8765/v1` and every
 * `POST /v1/chat/completions` / `POST /v1/messages` payload has its
 * fenced TS/JS code blocks compressed on the fly before the request is
 * forwarded upstream. Everything happens locally; the proxy adds no
 * telemetry and stores nothing. (Bare `POST /messages` is also accepted
 * and forwarded upstream as `/v1/messages`, so both Anthropic base-URL
 * conventions work — see injector/envInjector.ts.)
 *
 * Upstream resolution order:
 *   1. `x-contextdiet-upstream` request header
 *   2. `CONTEXTDIET_UPSTREAM` environment variable
 *   3. https://api.anthropic.com for /v1/messages,
 *      https://api.openai.com otherwise
 *
 * This module must NOT import `vscode` — configuration is passed in.
 */
import * as http from 'http';
import { compressCode, normalizeLevel } from '../engine/compress';
import { CompressionLevel } from '../engine/transformers/jsTsTransformer';

export type { CompressionLevel };

export interface ProxyOptions {
  port?: number;
  /** Static level, or a getter evaluated per request (live settings). */
  level?: CompressionLevel | (() => CompressionLevel);
  stripComments?: boolean | (() => boolean);
  stripLogs?: boolean | (() => boolean);
  /** Override upstream base URL (wins over env/header defaults). */
  upstream?: string;
}

export interface ProxyStatus {
  running: boolean;
  port: number | null;
  url: string | null;
}

const FENCE_PATTERN =
  /```(typescript|ts|tsx|javascript|js|jsx|mjs|cjs)\s*\n([\s\S]*?)```/g;

function resolveOption<T>(value: T | (() => T) | undefined, fallback: T): T {
  if (typeof value === 'function') {
    try {
      return (value as () => T)();
    } catch {
      return fallback;
    }
  }
  return value ?? fallback;
}

function compressTextContent(
  text: string,
  level: CompressionLevel,
  options: { stripComments?: boolean; stripLogs?: boolean },
): { text: string; blocks: number; savedTokens: number } {
  let blocks = 0;
  let savedTokens = 0;
  const out = text.replace(FENCE_PATTERN, (_match, lang: string, code: string) => {
    const trimmed = code.replace(/\n$/, '');
    if (!trimmed.trim()) {
      return _match;
    }
    const result = compressCode(trimmed, {
      level,
      stripComments: options.stripComments,
      stripLogs: options.stripLogs,
      filename: `snippet.${String(lang).toLowerCase()}`,
    });
    blocks += 1;
    savedTokens += result.savedTokens;
    const fenceLang = String(lang).toLowerCase();
    return '```' + fenceLang + '\n' + result.code + '\n```';
  });
  return { text: out, blocks, savedTokens };
}

function compressContentValue(
  content: unknown,
  level: CompressionLevel,
  options: { stripComments?: boolean; stripLogs?: boolean },
): unknown {
  if (typeof content === 'string') {
    return compressTextContent(content, level, options).text;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: string }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return {
          ...(part as Record<string, unknown>),
          text: compressTextContent(
            (part as { text: string }).text,
            level,
            options,
          ).text,
        };
      }
      return part;
    });
  }
  return content;
}

/**
 * Pure helper: compress every fenced TS/JS block inside an OpenAI- or
 * Anthropic-shaped chat payload. Returns a NEW payload object; prose and
 * non-code content are left untouched. Never throws.
 */
export function compressMessagePayload<T>(payload: T, level: CompressionLevel): T;
export function compressMessagePayload(
  payload: unknown,
  level: string,
  options?: { stripComments?: boolean; stripLogs?: boolean },
): unknown;
export function compressMessagePayload(
  payload: unknown,
  levelInput: string,
  options: { stripComments?: boolean; stripLogs?: boolean } = {},
): unknown {
  const level = normalizeLevel(levelInput);
  try {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }
    const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

    if (Array.isArray(clone.messages)) {
      clone.messages = (clone.messages as Array<Record<string, unknown>>).map(
        (message) => {
          if (!message || typeof message !== 'object') {
            return message;
          }
          return {
            ...message,
            content: compressContentValue(message.content, level, options),
          };
        },
      );
    }
    // Anthropic top-level `system` (string or text-block array).
    if (typeof clone.system === 'string' || Array.isArray(clone.system)) {
      clone.system = compressContentValue(clone.system, level, options);
    }
    return clone;
  } catch {
    return payload;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

let server: http.Server | null = null;
let activePort: number | null = null;
let activeOptions: ProxyOptions = {};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function resolveUpstream(req: http.IncomingMessage, pathname: string): string {
  const headerValue = req.headers['x-contextdiet-upstream'];
  const fromHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const base =
    activeOptions.upstream ||
    fromHeader ||
    process.env.CONTEXTDIET_UPSTREAM ||
    (pathname === '/v1/messages'
      ? 'https://api.anthropic.com'
      : 'https://api.openai.com');

  const cleanBase = base.replace(/\/+$/, '');
  // Avoid doubling /v1 when the configured base already ends with it.
  const suffix = cleanBase.endsWith('/v1') && pathname.startsWith('/v1')
    ? pathname.slice('/v1'.length)
    : pathname;
  return cleanBase + suffix;
}

async function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
    sendJson(res, 200, {
      ok: true,
      service: 'contextdiet-proxy',
      port: activePort,
      level: resolveOption(activeOptions.level, 'skeleton'),
    });
    return;
  }

  const isChatCompletion = pathname === '/v1/chat/completions';
  // Anthropic-shaped clients are configured with a base URL *without*
  // /v1 (their SDK appends /v1/messages itself — see
  // injector/envInjector.ts). Some tools instead treat the proxy root
  // as the full prefix and post to bare /messages. Accept both, and
  // always forward upstream as /v1/messages.
  const isMessages = pathname === '/v1/messages' || pathname === '/messages';
  const upstreamPath = pathname === '/messages' ? '/v1/messages' : pathname;
  if (req.method !== 'POST' || (!isChatCompletion && !isMessages)) {
    sendJson(res, 404, {
      error: {
        message:
          'ContextDiet proxy: only POST /v1/chat/completions, POST /v1/messages and POST /messages are intercepted; GET /health checks status.',
        type: 'not_found',
      },
    });
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    sendJson(res, 400, {
      error: {
        message: `ContextDiet proxy: failed reading request body: ${err instanceof Error ? err.message : String(err)}`,
        type: 'bad_request',
      },
    });
    return;
  }

  let outgoingBody = rawBody.toString('utf8');
  try {
    const parsed = JSON.parse(outgoingBody) as unknown;
    const level = normalizeLevel(
      resolveOption(activeOptions.level, 'skeleton' as CompressionLevel),
    );
    const compressed = compressMessagePayload(parsed, level, {
      stripComments: resolveOption(activeOptions.stripComments, true),
      stripLogs: resolveOption(activeOptions.stripLogs, true),
    });
    outgoingBody = JSON.stringify(compressed);
  } catch {
    // Non-JSON body: forward untouched.
  }

  const upstreamUrl = resolveUpstream(req, upstreamPath) + (url.search || '');

  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'connection' ||
      lower === 'x-contextdiet-upstream'
    ) {
      continue;
    }
    if (typeof value === 'string') {
      forwardHeaders[key] = value;
    } else if (Array.isArray(value)) {
      forwardHeaders[key] = value.join(', ');
    }
  }
  forwardHeaders['content-type'] = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: outgoingBody,
      signal: controller.signal,
    });
    const responseText = await upstreamResponse.text();
    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection') {
        return;
      }
      responseHeaders[key] = value;
    });
    res.writeHead(upstreamResponse.status, responseHeaders);
    res.end(responseText);
  } catch (err) {
    sendJson(res, 502, {
      error: {
        message: `ContextDiet proxy: upstream unreachable (${upstreamUrl}): ${err instanceof Error ? err.message : String(err)}`,
        type: 'proxy_error',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Start the proxy. Resolves with the status; never rejects. */
export function startProxy(options: ProxyOptions = {}): Promise<ProxyStatus> {
  if (server && activePort !== null) {
    return Promise.resolve(getProxyStatus());
  }
  activeOptions = options;
  const port = options.port ?? 8765;

  return new Promise<ProxyStatus>((resolve) => {
    const created = http.createServer((req, res) => {
      handleProxyRequest(req, res).catch((err) => {
        try {
          sendJson(res, 500, {
            error: {
              message: `ContextDiet proxy: internal error: ${err instanceof Error ? err.message : String(err)}`,
              type: 'proxy_internal_error',
            },
          });
        } catch {
          // response already closed
        }
      });
    });
    created.on('error', () => {
      // e.g. EADDRINUSE — report not-running instead of throwing.
      if (server === created) {
        server = null;
        activePort = null;
      }
      resolve({ running: false, port: null, url: null });
    });
    created.listen(port, '127.0.0.1', () => {
      server = created;
      activePort = port;
      resolve(getProxyStatus());
    });
  });
}

/** Stop the proxy if running. */
export function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const current = server;
    server = null;
    activePort = null;
    current.close(() => resolve());
    // Don't let lingering keep-alive sockets hang shutdown.
    if (typeof current.closeAllConnections === 'function') {
      current.closeAllConnections();
    }
  });
}

export function getProxyStatus(): ProxyStatus {
  if (server && activePort !== null) {
    return {
      running: true,
      port: activePort,
      url: `http://127.0.0.1:${activePort}`,
    };
  }
  return { running: false, port: null, url: null };
}
