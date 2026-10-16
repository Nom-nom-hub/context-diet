/**
 * Automatic environment injector — zero-setup routing for CLI agents.
 *
 * VS Code lets an extension contribute environment variables to every
 * integrated terminal via `ExtensionContext.environmentVariableCollection`.
 * ContextDiet uses that to point AI CLI tools at its local proxy without
 * the user ever editing a shell profile or exporting a base URL by hand:
 *
 *   OPENAI_BASE_URL    = http://127.0.0.1:{port}/v1
 *   ANTHROPIC_BASE_URL = http://127.0.0.1:{port}        (note: NO /v1)
 *
 * Why the difference matters:
 *  - OpenAI SDKs and OpenAI-compatible CLIs append `/chat/completions`
 *    to the configured base URL, so the base must already end in `/v1`.
 *  - Anthropic SDKs and Anthropic-shaped CLIs (e.g. Claude Code) append
 *    `/v1/messages` themselves, so the base must NOT end in `/v1` —
 *    otherwise requests would go to `/v1/v1/messages`.
 * The local proxy accepts both conventions: it serves `/v1/messages`
 * and the bare `/messages` alias, forwarding both upstream as
 * `/v1/messages` (see proxy/localProxy.ts).
 *
 * This module is intentionally free of `vscode` imports: the pure
 * helpers are unit-testable in plain Node, and the apply/clear wrappers
 * accept any structurally-compatible context object.
 */

export const OPENAI_BASE_URL_VAR = 'OPENAI_BASE_URL';
export const ANTHROPIC_BASE_URL_VAR = 'ANTHROPIC_BASE_URL';

export const INJECTED_ENV_VARS = [
  OPENAI_BASE_URL_VAR,
  ANTHROPIC_BASE_URL_VAR,
] as const;

export const INJECTOR_DESCRIPTION =
  "Routes OpenAI/Anthropic CLI traffic through ContextDiet's local compressor";

const DEFAULT_PORT = 8765;

function sanitizePort(port: number): number {
  return Number.isFinite(port) && port > 0 && port <= 65535
    ? Math.floor(port)
    : DEFAULT_PORT;
}

/**
 * Pure helper: the exact environment to inject for a given proxy port.
 *
 * OPENAI_BASE_URL ends with `/v1` (OpenAI clients append
 * `/chat/completions`); ANTHROPIC_BASE_URL deliberately does NOT
 * (Anthropic clients append `/v1/messages` themselves).
 */
export function buildInjectedEnv(port: number): Record<string, string> {
  const p = sanitizePort(port);
  return {
    [OPENAI_BASE_URL_VAR]: `http://127.0.0.1:${p}/v1`,
    [ANTHROPIC_BASE_URL_VAR]: `http://127.0.0.1:${p}`,
  };
}

/** Minimal structural shape of vscode's EnvironmentVariableCollection. */
export interface EnvironmentVariableCollectionLike {
  replace(variable: string, value: string): void;
  delete(variable: string): void;
  description?: string | { value: string } | undefined;
}

/** Minimal structural shape of vscode's ExtensionContext for injection. */
export interface EnvInjectorContextLike {
  environmentVariableCollection: EnvironmentVariableCollectionLike;
}

/**
 * Apply the injected environment to all integrated terminals spawned
 * afterwards. Existing terminals keep their original environment —
 * VS Code applies collection changes to newly created terminals.
 * Returns the environment that was applied.
 */
export function applyEnvInjector(
  context: EnvInjectorContextLike,
  port: number,
): Record<string, string> {
  const env = buildInjectedEnv(port);
  const collection = context.environmentVariableCollection;
  try {
    collection.description = INJECTOR_DESCRIPTION;
  } catch {
    // Description is cosmetic; never let it block the injection itself.
  }
  for (const [variable, value] of Object.entries(env)) {
    collection.replace(variable, value);
  }
  return env;
}

/** Remove every variable ContextDiet injected. */
export function clearEnvInjector(context: EnvInjectorContextLike): void {
  const collection = context.environmentVariableCollection;
  for (const variable of INJECTED_ENV_VARS) {
    try {
      collection.delete(variable);
    } catch {
      // Deleting an absent variable is harmless; ignore host quirks.
    }
  }
}
