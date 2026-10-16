# ContextDiet

**Put your codebase on a diet before it hits the prompt.**

ContextDiet is a VS Code extension that compresses TypeScript and JavaScript with a real AST engine — not regex guesswork — stripping comments, debug logging, unused imports and internal function bodies before code is fed to an AI model. Typical savings are **50–70% of tokens** on real-world files, while exported signatures and the logic an AI actually needs to reason about stay intact.

Everything runs **100% locally**. No code, no metadata, no telemetry ever leaves your machine — the only network traffic ContextDiet ever causes is your own AI requests passing through the local proxy you control.

---

## Why

Every file you paste into ChatGPT, Claude, Copilot or a CLI agent costs tokens, money and context window. Most of that weight is structural noise: JSDoc essays, `console.log` archaeology, imports nothing references, and helper implementations the model doesn't need when all you want is a refactor of the public API. ContextDiet removes exactly that noise, deterministically, from the AST — so the compressed output is still valid, faithful code, just lighter.

## The Simplified UX Rulebook

ContextDiet is designed so the *setup* is also on a diet. No shell profiles to edit, no base URLs to copy, no ports to memorise:

| User Goal | Traditional Clunky Way | ContextDiet Zero-Friction Way |
| :--- | :--- | :--- |
| **CLI Agents** (Claude Code, aider, OpenAI/Anthropic SDK scripts in the terminal) | Manually export `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` in every shell, edit dotfiles, restart terminals, debug why one tool wants `/v1` and the other breaks with it. | **Auto-injected terminal env.** On activation ContextDiet writes both variables into VS Code's environment collection for integrated terminals — OpenAI gets `http://127.0.0.1:8765/v1`, Anthropic gets `http://127.0.0.1:8765` (no `/v1` — see below). Open a terminal, run your agent, done. |
| **Copy/Pasting to Web UIs** (ChatGPT, Claude, Gemini) | Select code, copy, paste, watch half your context window evaporate on comments and log spam — or run a separate minifier tool and copy from there. | **Smart Copy.** Flip one toggle and `Cmd/Ctrl+C` in a TS/JS editor copies the *compressed* selection automatically. No commands, no extra step; if compression wouldn't shrink it, you get a normal copy. |
| **In-Editor AI Extensions** (Copilot, Continue, Roo, …) | Run a local proxy, reconfigure each extension's endpoint settings to a custom port, keep the proxy alive, repeat per tool. | **Native extension API.** Cooperating extensions call ContextDiet directly in-process — exported API, a callable command, the `#diet` LM tool, and a `contextdiet:` document scheme. No ports, no proxy required. One line of integration code for extension authors. |

## The four delivery channels

ContextDiet is tool-agnostic. However you talk to AI, there's a channel for it:

### 1. Universal Clipboard Bridge (zero setup)

Right-click any `.ts` / `.tsx` / `.js` / `.jsx` file in the Explorer or editor:

- **ContextDiet: Copy File as Skeleton Payload**
- **ContextDiet: Copy Selection as Skeleton Payload**
- **ContextDiet: Copy as Ultra-Slim Payload**
- **ContextDiet: Copy as Diet Payload**

The compressed payload lands on your system clipboard with a toast showing exactly what you saved:

> *ContextDiet: Skeleton copied! 1,840 → 620 tokens (66% saved)*

Paste it into ChatGPT, Claude, Gemini — any web UI or chat box.

#### Smart Copy — make Ctrl/Cmd+C itself do this

Enable **Smart Copy** (command: *ContextDiet: Toggle Smart Copy*, or the `contextDiet.enableSmartCopy` setting, off by default) and the ordinary copy shortcut gets smart in TypeScript/JavaScript editors:

- Select TS/JS code, press `Ctrl+C` / `Cmd+C` as usual — the **compressed** selection lands on your clipboard.
- Feedback is a brief status-bar note (`⚡ Diet: copied compressed (NN% saved)`), never a modal in your face.
- **Normal copy is never broken:** no selection, a non-TS/JS file, a compression hiccup, or a selection that wouldn't actually shrink → ContextDiet steps aside and VS Code's built-in copy runs exactly as stock.

The keybinding is gated by a context key plus language and selection clauses, so outside that narrow case the shortcut is 100% vanilla VS Code.

### 2. Local HTTP Proxy Interceptor

Start the proxy (it auto-starts when `contextDiet.enableLocalProxy` is on) and point any OpenAI- or Anthropic-compatible tool at it:

```text
http://127.0.0.1:8765/v1
```

The proxy intercepts `POST /v1/chat/completions` and `POST /v1/messages`, finds fenced `ts` / `tsx` / `js` / `jsx` code blocks inside the messages, compresses each one in flight, and forwards the slimmer payload to the real API. Works with Claude Code, aider, Continue, custom scripts — anything with a configurable base URL:

```bash
# Claude Code / Anthropic-shaped clients
export ANTHROPIC_BASE_URL=http://127.0.0.1:8765

# OpenAI-shaped clients
export OPENAI_BASE_URL=http://127.0.0.1:8765/v1
```

#### Zero setup: the terminal env is injected for you

You usually don't need those exports at all. With `contextDiet.autoInjectTerminalEnv` on (the default), activation writes both variables into VS Code's **integrated terminal environment** automatically:

| Variable | Injected value | Why |
| :--- | :--- | :--- |
| `OPENAI_BASE_URL` | `http://127.0.0.1:8765/v1` | OpenAI SDKs append `/chat/completions` to the base, so the base must end in `/v1`. |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8765` | Anthropic SDKs append `/v1/messages` themselves, so the base must **not** end in `/v1` (or you'd get `/v1/v1/messages`). |

Open a new integrated terminal and Claude Code / aider / your SDK scripts are already routed through the compressor. Notes:

- Injection applies to **newly opened** terminals (VS Code semantics); already-open terminals need a restart.
- Changing `contextDiet.proxyPort` re-points the injection; stopping the proxy or disabling injection clears it.
- Commands: *ContextDiet: Enable / Disable Terminal Env Injection*. Turn the setting off if you manage these variables yourself.
- The proxy also accepts bare `POST /messages` and forwards it upstream as `/v1/messages`, so tools built around either Anthropic base-URL convention work.

Details:

- `GET /health` returns `{ "ok": true, "service": "contextdiet-proxy", ... }`.
- Upstream resolution: `x-contextdiet-upstream` header → `CONTEXTDIET_UPSTREAM` env var → `https://api.anthropic.com` for `/v1/messages`, `https://api.openai.com` otherwise. Your auth headers are forwarded untouched.
- If the upstream is unreachable you get a clean `502` JSON error — never a hang.
- Manage it with **ContextDiet: Start / Stop / Toggle Local Proxy**.

### 3. File Scratchpad Export

Run **ContextDiet: Export Active File to Scratchpad** and the active file is compressed into:

```text
.contextdiet/active-context.ts
```

with a header recording the source file, level, token counts and timestamp. Then just tell your CLI agent:

> *Read `.contextdiet/active-context.ts` and refactor the interface.*

Perfect for terminal agents that read files but don't speak VS Code.

### 4. Native Extension API & Language Model Tool — no proxy at all

For AI tools that live *inside* the editor, ContextDiet offers a fully in-process path — no ports, no HTTP:

- **Exported extension API** (returned from `activate()`, `apiVersion: 1`):

```ts
const diet = await vscode.extensions
  .getExtension('contextdiet.context-diet')
  ?.activate();

const one = await diet.compress(sourceCode, 'skeleton');
// { compressed, originalTokens, compressedTokens, savedPct }

const two = await diet.compressFile('/abs/path/to/file.ts');
// also accepts a 'file://…' URI string
```

- **Callable command** for extensions that prefer `executeCommand`:

```ts
const result = await vscode.commands.executeCommand(
  'contextDiet.apiCompress',
  sourceCode,
  'skeleton',
);
// same { compressed, originalTokens, compressedTokens, savedPct } shape
```

- **`#diet` Language Model tool** (`contextdiet_compress`) registered via `vscode.lm.registerTool`, so chat agents can compress code mid-conversation.
- **`contextdiet:` document scheme** — a content provider that serves the compressed version of any file on demand (`contextdiet:/abs/path/to/file.ts?level=skeleton`). Try it yourself with *ContextDiet: Open Compressed Preview*, which opens the compressed twin of the active file beside the editor.

> **An honest note on how this works.** VS Code does **not** let one extension silently intercept another extension's document reads — there is no API for that, and any tool claiming otherwise is hand-waving. So the zero-proxy path is a *cooperating* integration: zero-config for users (install ContextDiet and it just works), and a one-line call for extension authors (the snippets above). Copilot Chat gets compression through the `#diet` LM tool; Continue/Roo-style extensions call the API, the command, or read through the `contextdiet:` scheme. Registration of the LM tool is feature-detected and guarded — on VS Code builds without that API, everything else still activates normally.

## Compression levels

| Level | Name | Target reduction | What it does |
| :--- | :--- | :--- | :--- |
| 01 | **Diet** (light) | ~30% | Removes JSDoc, inline comments and debug statements (`console.log`, `console.debug`, `console.trace`). All type signatures and syntax retained. |
| 02 | **Skeleton** (medium, default) | ~50–60% | Diet + prunes unreferenced internal helper functions, strips unused imports, and stubs non-exported internal function bodies with a `/* ...impl... */` placeholder. Exported APIs keep their full bodies. |
| 03 | **Ultra-Slim** (aggressive) | ~70%+ | Skeleton + interfaces flattened to single-line inline structural types, local identifiers inside function scopes minified via Babel scope renaming, compact code generation that condenses statement/loop layout. |

## Directive annotations

Two inline directives give you per-node control at any level:

```ts
// @diet-keep
function pricingFormula(input: Money): Money {
  // preserved in full, whatever the level — the AI needs this one
}

// @diet-strip
function debugDump(value: unknown): void {
  // removed entirely, even at Diet level
}
```

Directives work on function declarations, class declarations and methods, variable declarations, import/export statements, interfaces and type aliases. Directive targets are snapshotted before the AST is mutated, so a directive never bleeds onto a neighbouring declaration.

## Status bar HUD & Savings Dashboard

The status bar shows your last run live — `⚡ Diet: 64% Saved`. Click it to open the **Savings Dashboard**: session totals (tokens processed, tokens saved, estimated dollars saved at your selected model's list input pricing) plus a side-by-side Original vs Compressed view of the latest run with removed lines highlighted.

Dollar estimates use list input-token prices — Claude 3.5 Sonnet $3.00/MTok, GPT-4o $2.50/MTok, Gemini 1.5 Pro $1.25/MTok — and are labelled as estimates.

## Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `contextDiet.defaultCompressionLevel` | `skeleton` | Default level for context-menu copies and the proxy (`diet` / `skeleton` / `ultra-slim`). |
| `contextDiet.enableLocalProxy` | `true` | Auto-start the local HTTP proxy interceptor. |
| `contextDiet.proxyPort` | `8765` | Port for the local proxy. |
| `contextDiet.stripComments` | `true` | Remove comments and JSDoc blocks. |
| `contextDiet.stripLogs` | `true` | Remove `console.log` / `console.debug` / `console.trace` statements. |
| `contextDiet.targetModelPricing` | `claude-3-5-sonnet` | Pricing tier used for dashboard dollar estimates. |
| `contextDiet.autoInjectTerminalEnv` | `true` | Inject `OPENAI_BASE_URL` (`…/v1`) and `ANTHROPIC_BASE_URL` (no `/v1`) into integrated terminals so CLI agents route through the local proxy with zero manual setup. New terminals only. |
| `contextDiet.enableSmartCopy` | `false` | Smart Copy: `Ctrl/Cmd+C` in TS/JS editors copies the compressed selection; falls back to normal copy whenever compression wouldn't help. |

## Privacy: zero-trust by construction

- AST parsing, transformation and token counting happen on your machine, in a worker thread, using Babel and a local BPE tokenizer.
- There is no ContextDiet server. There is no analytics. There is nothing to opt out of.
- The proxy binds to `127.0.0.1` only and forwards exclusively to the upstream you configured.

## Fail-safe by design

If Babel can't parse a file (malformed code, bleeding-edge syntax), ContextDiet silently degrades to a string-aware regex fallback — comment stripping, log-line removal, blank-line collapsing — instead of throwing. You always get a payload, never an error dialog.

## Performance

Compression targets **< 100 ms for files under 3,000 lines**, and parsing runs on a dedicated `worker_threads` worker so the extension host UI never blocks. If the worker is unavailable, the same engine runs synchronously as a fallback — identical output, just on the main thread.

## Development

```bash
npm install
npm run compile   # tsc → out/
npm test          # unit tests (node:test) over the engine, proxy payload + server
npm run package   # build the .vsix
```

Press `F5` in VS Code to launch an Extension Development Host.

Project layout:

```text
src/
├── extension.ts                  # activation, commands, public API
├── engine/
│   ├── astParser.ts              # worker-thread manager + sync fallback
│   ├── compressionWorker.ts      # worker entry (parentPort)
│   ├── compress.ts               # synchronous engine core (no vscode imports)
│   ├── tokenizer.ts              # local BPE token counter (gpt-tokenizer)
│   ├── fallback.ts               # regex fail-safe compressor
│   ├── directives.ts             # @diet-keep / @diet-strip handling
│   └── transformers/
│       ├── jsTsTransformer.ts    # Babel AST transforms per level
│       └── typeFlattener.ts      # interface → single-line structural type
├── proxy/
│   └── localProxy.ts             # 127.0.0.1 HTTP interceptor (no vscode imports)
├── injector/
│   └── envInjector.ts            # terminal env injection helpers (no vscode imports)
├── tools/
│   └── lmToolProvider.ts         # #diet Language Model tool
└── ui/
    ├── statusBar.ts              # ⚡ Diet HUD
    └── webview/dashboard.ts      # savings dashboard + diff viewer
```

The engine, tokenizer and proxy payload logic import no `vscode` modules, so the whole core is unit-testable in plain Node — and reusable outside the editor.

## License

MIT © Andrew Edouard
