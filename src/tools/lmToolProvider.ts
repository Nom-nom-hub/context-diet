/**
 * VS Code Language Model tool provider — the `#diet` tool.
 *
 * Registers `contextdiet_compress` via `vscode.lm.registerTool` so any
 * chat participant / agent in VS Code (Copilot Chat, Continue, custom
 * extensions) can compress TS/JS before spending tokens on it. The API
 * is feature-detected and wrapped in try/catch: on VS Code builds where
 * the LM tool API is unavailable, activation continues unaffected.
 */
import * as vscode from 'vscode';
import { compressSync } from '../engine/astParser';
import { normalizeLevel } from '../engine/compress';

export interface DietToolInput {
  code: string;
  level?: string;
}

export type ToolStatsCallback = (stats: {
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  savedPercent: number;
  level: string;
  code: string;
  compressedCode: string;
}) => void;

class DietTool implements vscode.LanguageModelTool<DietToolInput> {
  constructor(private readonly onStats?: ToolStatsCallback) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DietToolInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input ?? ({ code: '' } as DietToolInput);
    const code = typeof input.code === 'string' ? input.code : '';
    const level = normalizeLevel(input.level);
    const result = compressSync(code, { level });

    this.onStats?.({
      originalTokens: result.originalTokens,
      compressedTokens: result.compressedTokens,
      savedTokens: result.savedTokens,
      savedPercent: result.savedPercent,
      level: result.level,
      code,
      compressedCode: result.code,
    });

    const summary =
      `ContextDiet (${result.level}): ${result.originalTokens.toLocaleString('en-US')} → ` +
      `${result.compressedTokens.toLocaleString('en-US')} tokens (${result.savedPercent}% saved)` +
      (result.fallbackUsed ? ' [regex fallback used]' : '');

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(summary + '\n\n' + result.code),
    ]);
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<DietToolInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    const level = normalizeLevel(options.input?.level);
    return {
      invocationMessage: `Compressing code with ContextDiet (${level})…`,
      confirmationMessages: {
        title: 'ContextDiet: compress code',
        message: new vscode.MarkdownString(
          `Compress the provided TypeScript/JavaScript at the **${level}** level? Processing is 100% local.`,
        ),
      },
    };
  }
}

/**
 * Register the #diet LM tool. Returns a disposable, or `undefined` when
 * the host does not expose the LM tool API. Never throws.
 */
export function registerLmTool(
  onStats?: ToolStatsCallback,
): vscode.Disposable | undefined {
  try {
    const lm = (vscode as unknown as { lm?: typeof vscode.lm }).lm;
    if (!lm || typeof lm.registerTool !== 'function') {
      return undefined;
    }
    return lm.registerTool('contextdiet_compress', new DietTool(onStats));
  } catch {
    return undefined;
  }
}
