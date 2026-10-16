/**
 * Tests for the pure terminal-env injector helpers (no vscode imports).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEnvInjector,
  buildInjectedEnv,
  clearEnvInjector,
  INJECTOR_DESCRIPTION,
  EnvironmentVariableCollectionLike,
} from '../src/injector/envInjector';

test('buildInjectedEnv: OpenAI base ends with /v1, Anthropic base does not', () => {
  const env = buildInjectedEnv(8765);
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:8765/v1');
  assert.ok(env.OPENAI_BASE_URL.endsWith('/v1'), 'OpenAI base ends with /v1');
  assert.ok(env.OPENAI_BASE_URL.includes('8765'), 'OpenAI base contains the port');

  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8765');
  assert.ok(
    env.ANTHROPIC_BASE_URL.includes('8765'),
    'Anthropic base contains the port',
  );
  assert.ok(
    !env.ANTHROPIC_BASE_URL.endsWith('/v1'),
    'Anthropic base must NOT end with /v1 (SDK appends /v1/messages itself)',
  );
});

test('buildInjectedEnv: honours a custom port on both variables', () => {
  const env = buildInjectedEnv(9999);
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:9999/v1');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9999');
});

type FakeCollection = EnvironmentVariableCollectionLike & {
  vars: Map<string, string>;
};

function makeFakeContext(): {
  context: { environmentVariableCollection: FakeCollection };
  collection: FakeCollection;
} {
  const vars = new Map<string, string>();
  const collection: FakeCollection = {
    vars,
    description: undefined,
    replace(variable: string, value: string) {
      vars.set(variable, value);
    },
    delete(variable: string) {
      vars.delete(variable);
    },
  };
  return {
    context: { environmentVariableCollection: collection },
    collection,
  };
}

test('applyEnvInjector replaces both variables and sets the description; clearEnvInjector removes them', () => {
  const { context, collection } = makeFakeContext();
  const applied = applyEnvInjector(context, 4321);
  assert.equal(collection.vars.get('OPENAI_BASE_URL'), 'http://127.0.0.1:4321/v1');
  assert.equal(collection.vars.get('ANTHROPIC_BASE_URL'), 'http://127.0.0.1:4321');
  assert.equal(collection.description, INJECTOR_DESCRIPTION);
  assert.deepEqual(applied, {
    OPENAI_BASE_URL: 'http://127.0.0.1:4321/v1',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321',
  });

  clearEnvInjector(context);
  assert.equal(collection.vars.size, 0, 'both variables deleted');
});
