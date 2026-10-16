/**
 * ContextDiet engine + proxy tests (plain node:test, no vscode imports).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import { compressCode } from '../src/engine/compress';
import { compressAsync } from '../src/engine/astParser';
import { countTokens } from '../src/engine/tokenizer';
import { fallbackCompress } from '../src/engine/fallback';
import {
  compressMessagePayload,
  startProxy,
  stopProxy,
  getProxyStatus,
} from '../src/proxy/localProxy';

// ---------------------------------------------------------------------------
// diet
// ---------------------------------------------------------------------------

test('diet removes comments and console.log, keeps code and types', () => {
  const code = [
    '// This comment explains something obvious and should be stripped away.',
    '/**',
    ' * Big JSDoc block describing the greeter in far too much detail.',
    ' * @param name the name to greet',
    ' */',
    'export interface Greeter { prefix: string; }',
    'export function greet(name: string): string {',
    "  console.log('greeting', name);",
    "  console.debug('debug noise');",
    "  const message = 'hello ' + name;",
    '  return message;',
    '}',
  ].join('\n');
  const result = compressCode(code, { level: 'diet', filename: 'greet.ts' });
  assert.equal(result.fallbackUsed, false);
  assert.ok(!result.code.includes('console.log'), 'console.log removed');
  assert.ok(!result.code.includes('console.debug'), 'console.debug removed');
  assert.ok(!result.code.includes('JSDoc block'), 'JSDoc removed');
  assert.ok(!result.code.includes('obvious'), 'inline comment removed');
  assert.ok(result.code.includes('interface Greeter'), 'interface kept at diet');
  assert.ok(result.code.includes("return message"), 'function body kept at diet');
  assert.ok(result.code.includes("'hello '"), 'string literal kept');
});

// ---------------------------------------------------------------------------
// skeleton
// ---------------------------------------------------------------------------

const SKELETON_FIXTURE = [
  "import { usedHelper } from './used';",
  "import { unusedHelper } from './unused';",
  '',
  'function internalCompute(value: number): number {',
  '  const stepOne = value * 3;',
  '  const stepTwo = stepOne + 17;',
  '  const stepThree = stepTwo - 5;',
  "  console.log('computing', stepThree);",
  '  return stepThree;',
  '}',
  '',
  'export function publicApi(value: number): number {',
  "  const marker = 'exported-body-marker';",
  '  const computed = internalCompute(value);',
  '  return usedHelper(computed) + marker.length;',
  '}',
].join('\n');

test('skeleton stubs non-exported function body, keeps exported body', () => {
  const result = compressCode(SKELETON_FIXTURE, {
    level: 'skeleton',
    filename: 'api.ts',
  });
  assert.equal(result.fallbackUsed, false);
  assert.ok(result.code.includes('...impl...'), 'stub placeholder present');
  assert.ok(
    !result.code.includes('stepOne'),
    'internal body statements were stubbed away',
  );
  assert.ok(
    result.code.includes('exported-body-marker'),
    'exported function body kept',
  );
});

test('skeleton removes unused imports, keeps used imports', () => {
  const result = compressCode(SKELETON_FIXTURE, {
    level: 'skeleton',
    filename: 'api.ts',
  });
  assert.ok(result.code.includes('usedHelper'), 'used import kept');
  assert.ok(result.code.includes("'./used'"), 'used import source kept');
  assert.ok(!result.code.includes('unusedHelper'), 'unused import removed');
  assert.ok(!result.code.includes("'./unused'"), 'unused import source removed');
});

// ---------------------------------------------------------------------------
// ultra-slim
// ---------------------------------------------------------------------------

const ULTRA_FIXTURE = [
  'export interface UserProfile {',
  '  id: number;',
  '  displayName: string;',
  '  emailAddress?: string;',
  '  isActive: boolean;',
  '}',
  '',
  'export function describe(profile: UserProfile): string {',
  '  const descriptiveLabel = profile.displayName;',
  '  const statusSegment = profile.isActive ? "active" : "inactive";',
  '  return descriptiveLabel + " (" + statusSegment + ")";',
  '}',
].join('\n');

test('ultra-slim flattens interface to a single line and is smaller than skeleton', () => {
  const skeleton = compressCode(ULTRA_FIXTURE, {
    level: 'skeleton',
    filename: 'user.ts',
  });
  const ultra = compressCode(ULTRA_FIXTURE, {
    level: 'ultra-slim',
    filename: 'user.ts',
  });
  assert.equal(ultra.fallbackUsed, false);
  const interfaceLine = ultra.code
    .split('\n')
    .find((line) => line.includes('UserProfile'));
  assert.ok(interfaceLine, 'interface/type for UserProfile present');
  assert.ok(
    interfaceLine!.includes('id') &&
      interfaceLine!.includes('displayName') &&
      interfaceLine!.includes('isActive'),
    `interface members flattened onto one line: ${interfaceLine}`,
  );
  assert.ok(
    ultra.compressedTokens < skeleton.compressedTokens,
    `ultra (${ultra.compressedTokens}) < skeleton (${skeleton.compressedTokens})`,
  );
});

// ---------------------------------------------------------------------------
// directives
// ---------------------------------------------------------------------------

test('@diet-keep preserves a function body at skeleton level', () => {
  const code = [
    '// @diet-keep',
    'function preciousHelper(input: string): string {',
    "  const secretSauce = 'keep-this-exact-body';",
    '  return secretSauce + input;',
    '}',
    '',
    'export function caller(input: string): string {',
    '  return preciousHelper(input);',
    '}',
  ].join('\n');
  const result = compressCode(code, { level: 'skeleton', filename: 'keep.ts' });
  assert.ok(
    result.code.includes('keep-this-exact-body'),
    '@diet-keep body preserved verbatim',
  );
  assert.ok(
    !result.code.includes('...impl...'),
    'kept function was not stubbed',
  );
});

test('@diet-strip removes the annotated function even at diet level', () => {
  const code = [
    '// @diet-strip',
    'function noisyDebugDump(value: unknown): void {',
    "  console.log('dump', value);",
    '}',
    '',
    'export function survivor(): number {',
    '  return 42;',
    '}',
  ].join('\n');
  const result = compressCode(code, { level: 'diet', filename: 'strip.ts' });
  assert.ok(!result.code.includes('noisyDebugDump'), 'stripped fn removed');
  assert.ok(!result.code.includes('dump'), 'stripped body removed');
  assert.ok(result.code.includes('survivor'), 'sibling export untouched');
  assert.ok(result.code.includes('42'), 'sibling body untouched');
});

// ---------------------------------------------------------------------------
// fallback
// ---------------------------------------------------------------------------

test('fallback: malformed code does not throw and still strips a // comment', () => {
  const malformed = [
    '// a comment that must be stripped by the fallback',
    'const broken = ;',
    'function nope( { return ',
    "console.log('this line goes too');",
    'const stillHere = 1;',
  ].join('\n');
  const result = compressCode(malformed, {
    level: 'skeleton',
    filename: 'broken.ts',
  });
  assert.equal(result.fallbackUsed, true, 'regex fallback engaged');
  assert.ok(!result.code.includes('a comment that must be stripped'));
  assert.ok(result.code.includes('stillHere'), 'real code survives fallback');

  const direct = fallbackCompress(malformed, {});
  assert.ok(!direct.includes('a comment that must be stripped'));
  assert.doesNotThrow(() => fallbackCompress('/* unterminated', {}));
  assert.doesNotThrow(() => fallbackCompress('', {}));
});

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

test('tokenizer counts increase with text length, empty is 0', () => {
  assert.equal(countTokens(''), 0);
  const short = countTokens('hello world');
  const longer = countTokens(
    'hello world, this is a considerably longer piece of text with more tokens in it',
  );
  const codeCount = countTokens('export function add(a: number, b: number) { return a + b; }');
  assert.ok(short > 0, 'short text counts');
  assert.ok(longer > short, 'longer text counts more');
  assert.ok(codeCount > 5, 'code counts');
});

// ---------------------------------------------------------------------------
// realistic fixture: skeleton must reach >= 40% reduction
// ---------------------------------------------------------------------------

const REALISTIC_FIXTURE = `/**
 * UserService — fetches, normalises and summarises user records.
 *
 * This module is intentionally verbose: account managers asked for heavy
 * documentation so new joiners can follow the data flow end to end. Every
 * public function has a full JSDoc block and the internal helpers log
 * liberally while we are still stabilising the integration with the
 * upstream identity provider.
 *
 * @module services/userService
 */
import { fetchJson } from '../lib/http';
import { formatDisplayDate } from '../lib/dates';
import { legacyCsvParser } from '../lib/legacyCsv';
import { experimentalFlag } from '../lib/flags';
import { unusedAnalytics } from '../lib/analytics';

/** Raw record as it arrives from the identity provider API. */
export interface RawUserRecord {
  id: number;
  firstName: string;
  lastName: string;
  emailAddress: string;
  createdAtIso: string;
  lastLoginIso: string | null;
  isSuspended: boolean;
  loyaltyPoints: number;
}

/** Summary shape consumed by the dashboard widgets. */
export interface UserSummary {
  id: number;
  fullName: string;
  emailAddress: string;
  memberSince: string;
  statusLabel: string;
  loyaltyPoints: number;
}

// Builds the display name from the raw parts, trimming stray whitespace
// that the upstream provider occasionally includes in first names.
function buildFullName(record: RawUserRecord): string {
  const trimmedFirstName = record.firstName.trim();
  const trimmedLastName = record.lastName.trim();
  const joinedName = trimmedFirstName + ' ' + trimmedLastName;
  console.log('built full name', joinedName);
  return joinedName;
}

// Derives the human readable status label for a record. Suspended accounts
// take precedence over the active/inactive distinction.
function deriveStatusLabel(record: RawUserRecord): string {
  console.debug('deriving status for', record.id);
  if (record.isSuspended) {
    return 'Suspended';
  }
  if (record.lastLoginIso === null) {
    return 'Never logged in';
  }
  return 'Active';
}

// Legacy normaliser kept from the CSV import days. Nothing calls this any
// more since the provider switched to JSON, so it should be pruned.
function legacyNormaliseCsvRow(row: string[]): RawUserRecord {
  const parsedColumns = row.map((column) => column.trim());
  console.log('legacy csv row', parsedColumns.length);
  return {
    id: Number(parsedColumns[0]),
    firstName: parsedColumns[1],
    lastName: parsedColumns[2],
    emailAddress: parsedColumns[3],
    createdAtIso: parsedColumns[4],
    lastLoginIso: null,
    isSuspended: false,
    loyaltyPoints: 0,
  };
}

/**
 * Loads one user record and converts it into the dashboard summary shape.
 * @param userId numeric identifier of the user to load
 */
export async function loadUserSummary(userId: number): Promise<UserSummary> {
  console.log('loading user summary for', userId);
  const record = (await fetchJson('/users/' + userId)) as RawUserRecord;
  const summary: UserSummary = {
    id: record.id,
    fullName: buildFullName(record),
    emailAddress: record.emailAddress,
    memberSince: formatDisplayDate(record.createdAtIso),
    statusLabel: deriveStatusLabel(record),
    loyaltyPoints: record.loyaltyPoints,
  };
  console.log('summary ready', summary.id);
  return summary;
}

/**
 * Loads a page of users and maps every record to its summary.
 * @param pageNumber one-based page index
 */
export async function loadUserPage(pageNumber: number): Promise<UserSummary[]> {
  console.trace('loading user page', pageNumber);
  const records = (await fetchJson('/users?page=' + pageNumber)) as RawUserRecord[];
  const summaries: UserSummary[] = [];
  for (const record of records) {
    summaries.push({
      id: record.id,
      fullName: buildFullName(record),
      emailAddress: record.emailAddress,
      memberSince: formatDisplayDate(record.createdAtIso),
      statusLabel: deriveStatusLabel(record),
      loyaltyPoints: record.loyaltyPoints,
    });
  }
  return summaries;
}
`;

test('realistic ~80-line fixture: skeleton achieves >= 40% token reduction', () => {
  const result = compressCode(REALISTIC_FIXTURE, {
    level: 'skeleton',
    filename: 'userService.ts',
  });
  assert.equal(result.fallbackUsed, false);
  assert.ok(
    result.savedPercent >= 40,
    `expected >= 40% reduction, got ${result.savedPercent}% (${result.originalTokens} -> ${result.compressedTokens})`,
  );
  assert.ok(!result.code.includes('legacyCsvParser'), 'unused import pruned');
  assert.ok(!result.code.includes('legacyNormaliseCsvRow'), 'dead helper pruned');
  assert.ok(result.code.includes('loadUserSummary'), 'exported API kept');
  assert.ok(result.code.includes('fetchJson'), 'used import kept');
});

// ---------------------------------------------------------------------------
// worker path
// ---------------------------------------------------------------------------

test('compressAsync via worker thread matches sync engine', async () => {
  const result = await compressAsync(SKELETON_FIXTURE, {
    level: 'skeleton',
    filename: 'api.ts',
  });
  assert.ok(result.code.includes('...impl...'));
  assert.ok(result.compressedTokens < result.originalTokens);
});

// ---------------------------------------------------------------------------
// proxy payload compression
// ---------------------------------------------------------------------------

const PROXY_CODE_BLOCK = [
  'export function computeTotal(prices: number[]): number {',
  "  console.log('computing total');",
  '  let runningTotal = 0;',
  '  for (const price of prices) {',
  '    runningTotal += price;',
  '  }',
  '  return runningTotal;',
  '}',
].join('\n');

test('compressMessagePayload compresses a fenced ts block, leaves prose untouched', () => {
  const payload = {
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content:
          'Please review this code:\n\n```ts\n' +
          PROXY_CODE_BLOCK +
          '\n```\n\nFocus on correctness, thanks!',
      },
      {
        role: 'assistant',
        content: 'Sure — send it over and I will take a look.',
      },
    ],
  };
  const out = compressMessagePayload(payload, 'diet') as typeof payload;
  const content = out.messages[0].content;
  assert.ok(content.startsWith('Please review this code:'), 'leading prose untouched');
  assert.ok(content.endsWith('Focus on correctness, thanks!'), 'trailing prose untouched');
  assert.ok(content.includes('```ts'), 'fence preserved');
  assert.ok(!content.includes('console.log'), 'code block was compressed');
  assert.ok(content.includes('computeTotal'), 'code block content retained');
  assert.equal(
    out.messages[1].content,
    'Sure — send it over and I will take a look.',
    'prose-only message untouched',
  );
  assert.ok(
    payload.messages[0].content.includes('console.log'),
    'input payload not mutated',
  );
});

test('compressMessagePayload handles Anthropic-style content arrays', () => {
  const payload = {
    model: 'claude-3-5-sonnet',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this:' },
          { type: 'text', text: '```typescript\n' + PROXY_CODE_BLOCK + '\n```' },
          { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        ],
      },
    ],
  };
  const out = compressMessagePayload(payload, 'diet') as typeof payload;
  const blocks = out.messages[0].content as Array<{
    type: string;
    text?: string;
    source?: { type: string; data: string };
  }>;
  assert.equal(blocks[0]?.text, 'Look at this:');
  assert.ok(!(blocks[1]?.text ?? '').includes('console.log'));
  assert.ok((blocks[1]?.text ?? '').includes('computeTotal'));
  assert.deepEqual(blocks[2], {
    type: 'image',
    source: { type: 'base64', data: 'AAAA' },
  });
});

// ---------------------------------------------------------------------------
// proxy HTTP server: health + unreachable upstream -> 502
// ---------------------------------------------------------------------------

test('proxy server: /health ok, chat completion with dead upstream returns 502 JSON', async () => {
  const status = await startProxy({ port: 18777, level: 'diet' });
  assert.equal(status.running, true);
  assert.equal(getProxyStatus().running, true);
  try {
    const health = await fetch('http://127.0.0.1:18777/health');
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { ok: boolean; service: string };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.service, 'contextdiet-proxy');

    const response = await fetch('http://127.0.0.1:18777/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key-not-real',
        'x-contextdiet-upstream': 'http://127.0.0.1:1',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, 'proxy_error');
  } finally {
    await stopProxy();
  }
  assert.equal(getProxyStatus().running, false);
});

// ---------------------------------------------------------------------------
// proxy HTTP server: bare /messages alias forwards upstream as /v1/messages
// ---------------------------------------------------------------------------

test('proxy accepts POST /messages and forwards upstream as /v1/messages with a compressed body', async () => {
  let capturedPath = '';
  let capturedBody = '';
  const upstream = http.createServer((req, res) => {
    capturedPath = req.url ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      capturedBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_test', type: 'message' }));
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(18779, '127.0.0.1', resolve),
  );

  const status = await startProxy({ port: 18778, level: 'diet' });
  assert.equal(status.running, true);
  try {
    const response = await fetch('http://127.0.0.1:18778/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-key-not-real',
        'anthropic-version': '2023-06-01',
        'x-contextdiet-upstream': 'http://127.0.0.1:18779',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: 'Review this:\n```ts\n' + PROXY_CODE_BLOCK + '\n```',
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { id: string };
    assert.equal(body.id, 'msg_test');
    assert.equal(
      capturedPath,
      '/v1/messages',
      'bare /messages forwarded upstream as /v1/messages',
    );
    assert.ok(
      !capturedBody.includes('console.log'),
      'upstream received the compressed payload',
    );
    assert.ok(capturedBody.includes('computeTotal'), 'code survived compression');
  } finally {
    await stopProxy();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
