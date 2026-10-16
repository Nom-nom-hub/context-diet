/**
 * Savings Dashboard webview.
 *
 * Shows session metrics (processed / saved / estimated $ saved) and a
 * side-by-side Original vs Compressed view of the most recent run, with
 * removed lines highlighted. All HTML is generated locally with a strict
 * CSP and user code is HTML-escaped before interpolation.
 */
import * as vscode from 'vscode';
import { SessionTotals } from '../statusBar';

/** Input-token list prices (USD per 1M tokens) used for $ estimates. */
export const MODEL_PRICING_PER_MTOK: Record<string, number> = {
  'claude-3-5-sonnet': 3.0,
  'gpt-4o': 2.5,
  'gemini-1-5-pro': 1.25,
};

export interface CompressionRecord {
  label: string;
  level: string;
  originalCode: string;
  compressedCode: string;
  originalTokens: number;
  compressedTokens: number;
  savedPercent: number;
  fallbackUsed: boolean;
  timestamp: Date;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function diffLines(original: string, compressed: string): {
  originalHtml: string;
  compressedHtml: string;
  removedCount: number;
} {
  const compressedSet = new Map<string, number>();
  for (const line of compressed.split('\n')) {
    const key = line.trim();
    compressedSet.set(key, (compressedSet.get(key) ?? 0) + 1);
  }
  let removedCount = 0;
  const originalHtml = original
    .split('\n')
    .map((line) => {
      const key = line.trim();
      const available = compressedSet.get(key) ?? 0;
      if (key !== '' && available > 0) {
        compressedSet.set(key, available - 1);
        return `<span class="line kept">${escapeHtml(line) || ' '}</span>`;
      }
      if (key !== '') {
        removedCount += 1;
        return `<span class="line removed">${escapeHtml(line) || ' '}</span>`;
      }
      return `<span class="line">${escapeHtml(line) || ' '}</span>`;
    })
    .join('\n');
  const compressedHtml = compressed
    .split('\n')
    .map((line) => `<span class="line kept">${escapeHtml(line) || ' '}</span>`)
    .join('\n');
  return { originalHtml, compressedHtml, removedCount };
}

export function buildDashboardHtml(args: {
  totals: SessionTotals;
  record: CompressionRecord | null;
  pricingModel: string;
  proxyStatus: { running: boolean; url: string | null };
}): string {
  const { totals, record, pricingModel, proxyStatus } = args;
  const pricePerMtok = MODEL_PRICING_PER_MTOK[pricingModel] ?? 3.0;
  const dollarsSaved =
    (totals.totalSavedTokens / 1_000_000) * pricePerMtok;

  const diff = record
    ? diffLines(record.originalCode, record.compressedCode)
    : null;

  const recordSection = record
    ? `
    <h2>Latest compression — ${escapeHtml(record.label)} <span class="badge">${escapeHtml(record.level)}</span>${record.fallbackUsed ? ' <span class="badge warn">regex fallback</span>' : ''}</h2>
    <p class="meta">${record.originalTokens.toLocaleString('en-US')} → ${record.compressedTokens.toLocaleString('en-US')} tokens (${record.savedPercent}% saved) · ${diff ? diff.removedCount : 0} line(s) removed or stubbed · ${escapeHtml(record.timestamp.toLocaleString('en-US'))}</p>
    <div class="diff">
      <div class="pane">
        <h3>Original</h3>
        <pre>${diff?.originalHtml ?? ''}</pre>
      </div>
      <div class="pane">
        <h3>Compressed payload</h3>
        <pre>${diff?.compressedHtml ?? ''}</pre>
      </div>
    </div>`
    : `<h2>Latest compression</h2><p class="meta">No compressions yet this session. Right-click a TS/JS file and choose a ContextDiet copy command.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ContextDiet Savings Dashboard</title>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 24px 0 6px; }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 6px; opacity: .75; }
  .sub { opacity: .75; margin: 0 0 16px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; }
  .card { border: 1px solid var(--vscode-panel-border, #444); border-radius: 8px; padding: 14px 18px; min-width: 170px; }
  .card .value { font-size: 24px; font-weight: 700; }
  .card .label { opacity: .75; font-size: 12px; margin-top: 2px; }
  .diff { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .pane pre { border: 1px solid var(--vscode-panel-border, #444); border-radius: 8px; padding: 10px; overflow: auto; max-height: 520px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.45; white-space: pre; }
  .line { display: block; padding: 0 4px; }
  .line.removed { background: rgba(255, 70, 70, .16); text-decoration: line-through; opacity: .8; }
  .badge { border: 1px solid var(--vscode-panel-border, #444); border-radius: 999px; padding: 1px 8px; font-size: 11px; }
  .badge.warn { border-color: #b58900; color: #e2b93d; }
  .meta { opacity: .8; }
  code { font-family: var(--vscode-editor-font-family, monospace); }
</style>
</head>
<body>
  <h1>⚡ ContextDiet — Savings Dashboard</h1>
  <p class="sub">Session totals · pricing model: <code>${escapeHtml(pricingModel)}</code> ($${pricePerMtok.toFixed(2)}/MTok input, estimate) · proxy: ${proxyStatus.running ? `<code>${escapeHtml(proxyStatus.url ?? '')}/v1</code> running` : 'stopped'}</p>
  <div class="cards">
    <div class="card"><div class="value">${totals.totalOriginalTokens.toLocaleString('en-US')}</div><div class="label">Total tokens processed</div></div>
    <div class="card"><div class="value">${totals.totalSavedTokens.toLocaleString('en-US')}</div><div class="label">Total tokens saved (${totals.overallSavedPercent}%)</div></div>
    <div class="card"><div class="value">$${dollarsSaved.toFixed(4)}</div><div class="label">Estimated $ saved (input tokens)</div></div>
    <div class="card"><div class="value">${totals.runs}</div><div class="label">Compression runs</div></div>
  </div>
  ${recordSection}
  <p class="meta">Estimates use list input-token pricing and the local tokenizer count. All processing happens on this machine — no code leaves your editor except through your own configured AI endpoints.</p>
</body>
</html>`;
}

export class DashboardManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private lastRecord: CompressionRecord | null = null;
  private pricingModel = 'claude-3-5-sonnet';
  private proxyStatus: { running: boolean; url: string | null } = {
    running: false,
    url: null,
  };

  constructor(
    private readonly getTotals: () => SessionTotals,
  ) {}

  setPricingModel(model: string): void {
    this.pricingModel = model;
    this.refresh();
  }

  setProxyStatus(status: { running: boolean; url: string | null }): void {
    this.proxyStatus = status;
    this.refresh();
  }

  /** Store the latest run and refresh the panel if it is open. */
  update(record: CompressionRecord): void {
    this.lastRecord = record;
    this.refresh();
  }

  getLastRecord(): CompressionRecord | null {
    return this.lastRecord;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.refresh();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'contextDietDashboard',
      'ContextDiet Savings',
      vscode.ViewColumn.One,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.refresh();
  }

  private refresh(): void {
    if (!this.panel) {
      return;
    }
    this.panel.webview.html = buildDashboardHtml({
      totals: this.getTotals(),
      record: this.lastRecord,
      pricingModel: this.pricingModel,
      proxyStatus: this.proxyStatus,
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}
