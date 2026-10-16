/**
 * Status bar HUD: `⚡ Diet: NN% Saved`.
 *
 * Keeps in-memory session totals (no persistence, no telemetry) and
 * opens the Savings Dashboard when clicked.
 */
import * as vscode from 'vscode';

export interface CompressionStats {
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  savedPercent: number;
  level: string;
}

export interface SessionTotals {
  runs: number;
  totalOriginalTokens: number;
  totalCompressedTokens: number;
  totalSavedTokens: number;
  overallSavedPercent: number;
  lastSavedPercent: number;
  lastLevel: string | null;
}

const EMPTY_TOTALS: SessionTotals = {
  runs: 0,
  totalOriginalTokens: 0,
  totalCompressedTokens: 0,
  totalSavedTokens: 0,
  overallSavedPercent: 0,
  lastSavedPercent: 0,
  lastLevel: null,
};

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private totals: SessionTotals = { ...EMPTY_TOTALS };

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.text = '⚡ Diet: —';
    this.item.tooltip = 'ContextDiet: no compressions yet this session.';
    this.item.command = 'contextDiet.showDashboard';
    this.item.show();
  }

  /** Record one compression run and refresh the HUD. */
  update(stats: CompressionStats): SessionTotals {
    this.totals.runs += 1;
    this.totals.totalOriginalTokens += stats.originalTokens;
    this.totals.totalCompressedTokens += stats.compressedTokens;
    this.totals.totalSavedTokens += Math.max(
      0,
      stats.originalTokens - stats.compressedTokens,
    );
    this.totals.lastSavedPercent = stats.savedPercent;
    this.totals.lastLevel = stats.level;
    this.totals.overallSavedPercent =
      this.totals.totalOriginalTokens > 0
        ? Math.round(
            (this.totals.totalSavedTokens / this.totals.totalOriginalTokens) *
              100,
          )
        : 0;

    this.item.text = `⚡ Diet: ${stats.savedPercent}% Saved`;
    const tooltip = new vscode.MarkdownString(
      [
        `**ContextDiet session**`,
        ``,
        `Last run (${stats.level}): ${stats.originalTokens.toLocaleString('en-US')} → ${stats.compressedTokens.toLocaleString('en-US')} tokens (${stats.savedPercent}% saved)`,
        ``,
        `Session: ${this.totals.runs} run(s), ${this.totals.totalSavedTokens.toLocaleString('en-US')} tokens saved overall (${this.totals.overallSavedPercent}%)`,
        ``,
        `Click to open the Savings Dashboard.`,
      ].join('\n'),
    );
    this.item.tooltip = tooltip;
    return this.getTotals();
  }

  getTotals(): SessionTotals {
    return { ...this.totals };
  }

  reset(): void {
    this.totals = { ...EMPTY_TOTALS };
    this.item.text = '⚡ Diet: —';
    this.item.tooltip = 'ContextDiet: no compressions yet this session.';
  }

  dispose(): void {
    this.item.dispose();
  }
}
