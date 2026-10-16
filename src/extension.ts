/**
 * ContextDiet extension entry point.
 *
 * Activation wires together:
 *  - the AST compression engine (worker-thread backed, sync fallback)
 *  - clipboard bridge commands (file / selection / levels)
 *  - Smart Copy (Ctrl/Cmd+C copies compressed selections when enabled)
 *  - the `.contextdiet/active-context.ts` scratchpad export
 *  - the local HTTP proxy interceptor (auto-starts when enabled)
 *  - the automatic terminal environment injector (OPENAI_BASE_URL /
 *    ANTHROPIC_BASE_URL → local proxy, zero manual base-URL setup)
 *  - the `#diet` Language Model tool
 *  - the native extension API (returned from activate), the
 *    `contextDiet.apiCompress` command, and the `contextdiet:` document
 *    content provider for cooperating in-editor extensions
 *  - the status bar HUD + savings dashboard
 *
 * All processing is local. Nothing in this extension transmits code or
 * metadata anywhere; the proxy only forwards requests to the upstream
 * the user configured.
 */
import * as vscode from 'vscode';
import { compressAsync } from './engine/astParser';
import {
  CompressionLevel,
  CompressResult,
  normalizeLevel,
} from './engine/compress';
import {
  getProxyStatus,
  startProxy,
  stopProxy,
} from './proxy/localProxy';
import {
  applyEnvInjector,
  clearEnvInjector,
} from './injector/envInjector';
import { registerLmTool } from './tools/lmToolProvider';
import { StatusBarManager } from './ui/statusBar';
import {
  CompressionRecord,
  DashboardManager,
} from './ui/webview/dashboard';

const SUPPORTED_LANGS = new Set([
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
]);

const LEVEL_LABELS: Record<CompressionLevel, string> = {
  diet: 'Diet',
  skeleton: 'Skeleton',
  'ultra-slim': 'Ultra-Slim',
};

interface DietSettings {
  defaultLevel: CompressionLevel;
  enableLocalProxy: boolean;
  proxyPort: number;
  stripComments: boolean;
  stripLogs: boolean;
  pricingModel: string;
  autoInjectTerminalEnv: boolean;
  enableSmartCopy: boolean;
}

function getSettings(): DietSettings {
  const config = vscode.workspace.getConfiguration('contextDiet');
  return {
    defaultLevel: normalizeLevel(
      config.get<string>('defaultCompressionLevel', 'skeleton'),
    ),
    enableLocalProxy: config.get<boolean>('enableLocalProxy', true),
    proxyPort: config.get<number>('proxyPort', 8765),
    stripComments: config.get<boolean>('stripComments', true),
    stripLogs: config.get<boolean>('stripLogs', true),
    pricingModel: config.get<string>(
      'targetModelPricing',
      'claude-3-5-sonnet',
    ),
    autoInjectTerminalEnv: config.get<boolean>('autoInjectTerminalEnv', true),
    enableSmartCopy: config.get<boolean>('enableSmartCopy', false),
  };
}

let statusBar: StatusBarManager | undefined;
let dashboard: DashboardManager | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

function recordResult(
  label: string,
  sourceCode: string,
  result: CompressResult,
): void {
  statusBar?.update({
    originalTokens: result.originalTokens,
    compressedTokens: result.compressedTokens,
    savedTokens: result.savedTokens,
    savedPercent: result.savedPercent,
    level: result.level,
  });
  const record: CompressionRecord = {
    label,
    level: result.level,
    originalCode: sourceCode,
    compressedCode: result.code,
    originalTokens: result.originalTokens,
    compressedTokens: result.compressedTokens,
    savedPercent: result.savedPercent,
    fallbackUsed: result.fallbackUsed,
    timestamp: new Date(),
  };
  dashboard?.update(record);
  const settings = getSettings();
  dashboard?.setPricingModel(settings.pricingModel);
  dashboard?.setProxyStatus(getProxyStatus());
}

async function compressText(
  code: string,
  level: CompressionLevel,
  filename: string,
): Promise<CompressResult> {
  const settings = getSettings();
  return compressAsync(code, {
    level,
    stripComments: settings.stripComments,
    stripLogs: settings.stripLogs,
    filename,
  });
}

// ---------------------------------------------------------------------------
// Native API result shape (public contract, apiVersion 1)
// ---------------------------------------------------------------------------

export interface NativeCompressResult {
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  savedPct: number;
}

function toNativeResult(result: CompressResult): NativeCompressResult {
  return {
    compressed: result.code,
    originalTokens: result.originalTokens,
    compressedTokens: result.compressedTokens,
    savedPct: result.savedPercent,
  };
}

async function compressNative(
  code: string,
  level: CompressionLevel,
  filename: string,
): Promise<NativeCompressResult> {
  const result = await compressText(code, level, filename);
  return toNativeResult(result);
}

// ---------------------------------------------------------------------------
// Automatic terminal environment injection
// ---------------------------------------------------------------------------

/**
 * Reconcile the injected terminal environment with current settings and
 * proxy state: injected exactly when the proxy is running AND both the
 * proxy and the auto-inject setting are enabled; cleared otherwise.
 */
function syncEnvInjection(): void {
  if (!extensionContext) {
    return;
  }
  const settings = getSettings();
  const status = getProxyStatus();
  if (
    status.running &&
    settings.enableLocalProxy &&
    settings.autoInjectTerminalEnv
  ) {
    applyEnvInjector(extensionContext, settings.proxyPort);
  } else {
    clearEnvInjector(extensionContext);
  }
}

async function setSmartCopyContext(enabled: boolean): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    'contextDiet.smartCopyEnabled',
    enabled,
  );
}

// ---------------------------------------------------------------------------
// File source resolution
// ---------------------------------------------------------------------------

/** Resolve source text for file-oriented commands. */
async function resolveFileSource(
  uri: vscode.Uri | undefined,
): Promise<{ code: string; label: string; filename: string } | null> {
  if (uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return {
        code: Buffer.from(bytes).toString('utf8'),
        label: vscode.workspace.asRelativePath(uri),
        filename: uri.fsPath,
      };
    } catch {
      void vscode.window.showErrorMessage(
        `ContextDiet: could not read ${uri.fsPath}`,
      );
      return null;
    }
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage(
      'ContextDiet: open a TypeScript/JavaScript file first.',
    );
    return null;
  }
  return {
    code: editor.document.getText(),
    label: vscode.workspace.asRelativePath(editor.document.uri),
    filename: editor.document.fileName,
  };
}

function toastCopied(level: CompressionLevel, result: CompressResult): void {
  const label = LEVEL_LABELS[level];
  void vscode.window.showInformationMessage(
    `ContextDiet: ${label} copied! ${result.originalTokens.toLocaleString('en-US')} → ${result.compressedTokens.toLocaleString('en-US')} tokens (${result.savedPercent}% saved)`,
  );
}

async function copyToClipboard(
  code: string,
  level: CompressionLevel,
  label: string,
  filename: string,
): Promise<void> {
  const result = await compressText(code, level, filename);
  await vscode.env.clipboard.writeText(result.code);
  recordResult(label, code, result);
  toastCopied(level, result);
}

async function handleCopyFile(
  uri: vscode.Uri | undefined,
  level: CompressionLevel,
): Promise<void> {
  const source = await resolveFileSource(uri);
  if (!source) {
    return;
  }
  await copyToClipboard(source.code, level, source.label, source.filename);
}

async function handleCopySelectionOrFile(
  level: CompressionLevel,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    const code = editor.document.getText(editor.selection);
    const label = `${vscode.workspace.asRelativePath(editor.document.uri)} (selection)`;
    await copyToClipboard(code, level, label, editor.document.fileName);
    return;
  }
  await handleCopyFile(undefined, level);
}

// ---------------------------------------------------------------------------
// Smart Copy
// ---------------------------------------------------------------------------

/**
 * Smart Copy: when enabled (and bound to Ctrl/Cmd+C by the keybinding's
 * when-clause), a TS/JS selection is compressed before it hits the
 * clipboard. In every other case — no selection, unsupported language,
 * compression failure, or output that isn't actually smaller — we defer
 * to VS Code's built-in copy so normal copy is never broken.
 */
async function handleSmartCopy(): Promise<void> {
  const fallbackToNativeCopy = async (): Promise<void> => {
    await vscode.commands.executeCommand(
      'editor.action.clipboardCopyAction',
    );
  };

  const editor = vscode.window.activeTextEditor;
  if (
    !editor ||
    editor.selection.isEmpty ||
    !SUPPORTED_LANGS.has(editor.document.languageId)
  ) {
    await fallbackToNativeCopy();
    return;
  }

  try {
    const selected = editor.document.getText(editor.selection);
    const level = getSettings().defaultLevel;
    const result = await compressText(
      selected,
      level,
      editor.document.fileName,
    );
    if (
      !result.code ||
      result.compressedTokens >= result.originalTokens ||
      result.code.length >= selected.length
    ) {
      await fallbackToNativeCopy();
      return;
    }
    await vscode.env.clipboard.writeText(result.code);
    recordResult(
      `${vscode.workspace.asRelativePath(editor.document.uri)} (smart copy)`,
      selected,
      result,
    );
    // Transient status-bar note — deliberately NOT a modal toast, so
    // copying stays frictionless and spam-free.
    vscode.window.setStatusBarMessage(
      `⚡ Diet: copied compressed (${result.savedPercent}% saved)`,
      3000,
    );
  } catch {
    await fallbackToNativeCopy();
  }
}

async function handleToggleSmartCopy(): Promise<void> {
  const config = vscode.workspace.getConfiguration('contextDiet');
  const next = !getSettings().enableSmartCopy;
  await config.update(
    'enableSmartCopy',
    next,
    vscode.ConfigurationTarget.Global,
  );
  await setSmartCopyContext(next);
  void vscode.window.showInformationMessage(
    next
      ? 'ContextDiet: Smart Copy ON — in TS/JS editors, Ctrl/Cmd+C now copies the compressed selection.'
      : 'ContextDiet: Smart Copy OFF — Ctrl/Cmd+C is back to normal copy everywhere.',
  );
}

// ---------------------------------------------------------------------------
// Scratchpad
// ---------------------------------------------------------------------------

async function handleExportToScratchpad(
  uri: vscode.Uri | undefined,
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    void vscode.window.showWarningMessage(
      'ContextDiet: open a workspace folder to use the scratchpad export.',
    );
    return;
  }
  const source = await resolveFileSource(uri);
  if (!source) {
    return;
  }
  const level = getSettings().defaultLevel;
  const result = await compressText(source.code, level, source.filename);
  recordResult(source.label, source.code, result);

  const header = [
    `// ─── ContextDiet scratchpad ─────────────────────────────────────────`,
    `// Source:    ${source.label}`,
    `// Level:     ${result.level}`,
    `// Tokens:    ${result.originalTokens.toLocaleString('en-US')} → ${result.compressedTokens.toLocaleString('en-US')} (${result.savedPercent}% saved)`,
    `// Generated: ${new Date().toISOString()}`,
    `// Point your CLI agent at this file, e.g.: "Read .contextdiet/active-context.ts"`,
    `// ─────────────────────────────────────────────────────────────────────`,
    '',
    '',
  ].join('\n');

  const dirUri = vscode.Uri.joinPath(workspaceFolder.uri, '.contextdiet');
  const fileUri = vscode.Uri.joinPath(dirUri, 'active-context.ts');
  try {
    await vscode.workspace.fs.createDirectory(dirUri);
    await vscode.workspace.fs.writeFile(
      fileUri,
      Buffer.from(header + result.code + '\n', 'utf8'),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `ContextDiet: scratchpad write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const doc = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(doc);
  void vscode.window.showInformationMessage(
    `ContextDiet: Scratchpad updated! ${result.originalTokens.toLocaleString('en-US')} → ${result.compressedTokens.toLocaleString('en-US')} tokens (${result.savedPercent}% saved)`,
  );
}

// ---------------------------------------------------------------------------
// Proxy lifecycle
// ---------------------------------------------------------------------------

async function startProxyFromSettings(showToast: boolean): Promise<void> {
  const settings = getSettings();
  const status = await startProxy({
    port: settings.proxyPort,
    level: () => getSettings().defaultLevel,
    stripComments: () => getSettings().stripComments,
    stripLogs: () => getSettings().stripLogs,
  });
  dashboard?.setProxyStatus(status);
  syncEnvInjection();
  if (showToast) {
    if (status.running) {
      void vscode.window.showInformationMessage(
        `ContextDiet: Proxy running at ${status.url}/v1 — new terminals already point there automatically.`,
      );
    } else {
      void vscode.window.showErrorMessage(
        `ContextDiet: Proxy failed to start on port ${settings.proxyPort} (already in use?).`,
      );
    }
  }
}

async function stopProxyAndSync(showToast: boolean): Promise<void> {
  await stopProxy();
  dashboard?.setProxyStatus(getProxyStatus());
  syncEnvInjection();
  if (showToast) {
    void vscode.window.showInformationMessage('ContextDiet: Proxy stopped.');
  }
}

// ---------------------------------------------------------------------------
// contextdiet: document content provider (compressed preview / API reads)
// ---------------------------------------------------------------------------

/**
 * Serves the compressed version of a file under the `contextdiet:`
 * scheme. The URI path is the original file's fs path; an optional
 * `?level=diet|skeleton|ultra-slim` query picks the level. Cooperating
 * extensions can open `contextdiet:/abs/path/to/file.ts` to read the
 * compressed text through VS Code's normal document APIs.
 */
class CompressedContentProvider
  implements vscode.TextDocumentContentProvider
{
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const fsPath = decodeURIComponent(uri.path);
    try {
      const levelParam = new URLSearchParams(uri.query).get('level');
      const level = levelParam
        ? normalizeLevel(levelParam)
        : getSettings().defaultLevel;
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(fsPath),
      );
      const code = Buffer.from(bytes).toString('utf8');
      const result = await compressText(code, level, fsPath);
      recordResult(fsPath, code, result);
      return result.code;
    } catch (err) {
      return `// ContextDiet: could not compress ${fsPath}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

async function handleOpenCompressedPreview(
  uri?: vscode.Uri,
): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    void vscode.window.showWarningMessage(
      'ContextDiet: open a TypeScript/JavaScript file first.',
    );
    return;
  }
  const compressedUri = vscode.Uri.from({
    scheme: 'contextdiet',
    path: target.fsPath,
    query: `level=${getSettings().defaultLevel}`,
  });
  const doc = await vscode.workspace.openTextDocument(compressedUri);
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
  });
}

// ---------------------------------------------------------------------------
// Public extension API (returned from activate)
// ---------------------------------------------------------------------------

export interface ContextDietApi {
  apiVersion: 1;
  compress(code: string, level?: string): Promise<NativeCompressResult>;
  compressFile(
    uriStringOrPath: string,
    level?: string,
  ): Promise<NativeCompressResult>;
  getProxyStatus(): {
    running: boolean;
    port: number | null;
    url: string | null;
  };
  isSupportedLanguage(languageId: string): boolean;
}

function resolveFileUri(uriStringOrPath: string): vscode.Uri {
  const raw = String(uriStringOrPath);
  if (raw.startsWith('file://')) {
    return vscode.Uri.parse(raw);
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    return vscode.Uri.parse(raw);
  }
  return vscode.Uri.file(raw);
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export async function activate(
  context: vscode.ExtensionContext,
): Promise<ContextDietApi> {
  extensionContext = context;
  statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  dashboard = new DashboardManager(() => statusBar!.getTotals());
  context.subscriptions.push(dashboard);
  dashboard.setPricingModel(getSettings().pricingModel);

  // Publish the Smart Copy context key so the Ctrl/Cmd+C keybinding's
  // when-clause only hijacks copy when the feature is actually on.
  await setSmartCopyContext(getSettings().enableSmartCopy);

  // contextdiet: scheme provider (compressed documents on demand).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      'contextdiet',
      new CompressedContentProvider(),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'contextDiet.copyFileAsSkeleton',
      async (uri?: vscode.Uri) => {
        await handleCopyFile(uri, 'skeleton');
      },
    ),
    vscode.commands.registerCommand(
      'contextDiet.copySelectionAsSkeleton',
      async () => {
        await handleCopySelectionOrFile('skeleton');
      },
    ),
    vscode.commands.registerCommand(
      'contextDiet.copyAsUltraSlim',
      async (uri?: vscode.Uri) => {
        const editor = vscode.window.activeTextEditor;
        if (!uri && editor && !editor.selection.isEmpty) {
          await handleCopySelectionOrFile('ultra-slim');
        } else {
          await handleCopyFile(uri, 'ultra-slim');
        }
      },
    ),
    vscode.commands.registerCommand(
      'contextDiet.copyAsDiet',
      async (uri?: vscode.Uri) => {
        const editor = vscode.window.activeTextEditor;
        if (!uri && editor && !editor.selection.isEmpty) {
          await handleCopySelectionOrFile('diet');
        } else {
          await handleCopyFile(uri, 'diet');
        }
      },
    ),
    vscode.commands.registerCommand(
      'contextDiet.exportToScratchpad',
      async (uri?: vscode.Uri) => {
        await handleExportToScratchpad(uri);
      },
    ),
    vscode.commands.registerCommand('contextDiet.showDashboard', () => {
      dashboard?.setPricingModel(getSettings().pricingModel);
      dashboard?.setProxyStatus(getProxyStatus());
      dashboard?.show();
    }),
    vscode.commands.registerCommand('contextDiet.startProxy', async () => {
      await startProxyFromSettings(true);
    }),
    vscode.commands.registerCommand('contextDiet.stopProxy', async () => {
      await stopProxyAndSync(true);
    }),
    vscode.commands.registerCommand('contextDiet.toggleProxy', async () => {
      if (getProxyStatus().running) {
        await stopProxyAndSync(true);
      } else {
        await startProxyFromSettings(true);
      }
    }),
    vscode.commands.registerCommand(
      'contextDiet.enableTerminalInjection',
      async () => {
        await vscode.workspace
          .getConfiguration('contextDiet')
          .update(
            'autoInjectTerminalEnv',
            true,
            vscode.ConfigurationTarget.Global,
          );
        if (!getProxyStatus().running && getSettings().enableLocalProxy) {
          await startProxyFromSettings(false);
        }
        syncEnvInjection();
        void vscode.window.showInformationMessage(
          'ContextDiet: Terminal env injection ON — new integrated terminals route OpenAI/Anthropic CLIs through the local compressor. Already-open terminals need a restart to pick it up.',
        );
      },
    ),
    vscode.commands.registerCommand(
      'contextDiet.disableTerminalInjection',
      async () => {
        await vscode.workspace
          .getConfiguration('contextDiet')
          .update(
            'autoInjectTerminalEnv',
            false,
            vscode.ConfigurationTarget.Global,
          );
        syncEnvInjection();
        void vscode.window.showInformationMessage(
          'ContextDiet: Terminal env injection OFF — OPENAI_BASE_URL / ANTHROPIC_BASE_URL removed from new terminals.',
        );
      },
    ),
    vscode.commands.registerCommand(
      'contextDiet.toggleSmartCopy',
      async () => {
        await handleToggleSmartCopy();
      },
    ),
    vscode.commands.registerCommand('contextDiet.smartCopy', async () => {
      await handleSmartCopy();
    }),
    vscode.commands.registerCommand(
      'contextDiet.apiCompress',
      async (
        code: unknown,
        level?: unknown,
      ): Promise<NativeCompressResult> => {
        const text = typeof code === 'string' ? code : '';
        const lvl =
          typeof level === 'string'
            ? normalizeLevel(level)
            : getSettings().defaultLevel;
        const result = await compressText(text, lvl, 'api-input.ts');
        recordResult('contextDiet.apiCompress', text, result);
        return toNativeResult(result);
      },
    ),
    vscode.commands.registerCommand(
      'contextDiet.openCompressedPreview',
      async (uri?: vscode.Uri) => {
        await handleOpenCompressedPreview(uri);
      },
    ),
  );

  // React to settings changes: dashboard pricing, Smart Copy context
  // key, proxy port moves (restart proxy, re-point injected env).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('contextDiet.targetModelPricing')) {
        dashboard?.setPricingModel(getSettings().pricingModel);
      }
      if (event.affectsConfiguration('contextDiet.enableSmartCopy')) {
        await setSmartCopyContext(getSettings().enableSmartCopy);
      }
      if (
        event.affectsConfiguration('contextDiet.proxyPort') &&
        getProxyStatus().running
      ) {
        await stopProxy();
        await startProxyFromSettings(false);
      }
      if (
        event.affectsConfiguration('contextDiet.enableLocalProxy') ||
        event.affectsConfiguration('contextDiet.autoInjectTerminalEnv') ||
        event.affectsConfiguration('contextDiet.proxyPort')
      ) {
        syncEnvInjection();
      }
    }),
  );

  // #diet Language Model tool (guarded — older hosts simply skip it).
  const lmTool = registerLmTool((stats) => {
    recordResult('#diet tool', stats.code, {
      code: stats.compressedCode,
      level: normalizeLevel(stats.level),
      originalTokens: stats.originalTokens,
      compressedTokens: stats.compressedTokens,
      savedTokens: stats.savedTokens,
      savedPercent: stats.savedPercent,
      fallbackUsed: false,
      durationMs: 0,
    });
  });
  if (lmTool) {
    context.subscriptions.push(lmTool);
  }

  // Auto-start the local proxy when enabled, then reconcile the
  // injected terminal environment with the final state.
  if (getSettings().enableLocalProxy) {
    await startProxyFromSettings(false);
  }
  syncEnvInjection();
  dashboard.setProxyStatus(getProxyStatus());

  // Public API for cooperating extensions (Copilot Chat participants,
  // Continue.dev, Roo-style tools, …):
  //   const api = vscode.extensions.getExtension('contextdiet.context-diet')?.activate();
  // NOTE: VS Code does not let one extension silently intercept another
  // extension's document reads — this exported API, the
  // `contextDiet.apiCompress` command, the #diet LM tool and the
  // `contextdiet:` content provider are the sanctioned integration
  // surfaces, and cooperating extensions call them explicitly.
  const api: ContextDietApi = {
    apiVersion: 1,
    async compress(
      code: string,
      level?: string,
    ): Promise<NativeCompressResult> {
      const lvl = level
        ? normalizeLevel(level)
        : getSettings().defaultLevel;
      return compressNative(String(code ?? ''), lvl, 'api-input.ts');
    },
    async compressFile(
      uriStringOrPath: string,
      level?: string,
    ): Promise<NativeCompressResult> {
      const fileUri = resolveFileUri(uriStringOrPath);
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const code = Buffer.from(bytes).toString('utf8');
      const lvl = level
        ? normalizeLevel(level)
        : getSettings().defaultLevel;
      return compressNative(code, lvl, fileUri.fsPath);
    },
    getProxyStatus,
    isSupportedLanguage(languageId: string): boolean {
      return SUPPORTED_LANGS.has(languageId);
    },
  };
  return api;
}

export async function deactivate(): Promise<void> {
  await stopProxy();
  statusBar?.dispose();
  dashboard?.dispose();
  statusBar = undefined;
  dashboard = undefined;
  extensionContext = undefined;
}
