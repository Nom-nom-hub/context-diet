/**
 * AST parser facade + worker-thread manager.
 *
 * Compression should never block the VS Code extension host, so work is
 * offloaded to a `worker_threads` Worker running
 * `compressionWorker.js`. If the worker cannot be created (missing build
 * output, restricted environment, timeout, crash) we fall back to the
 * synchronous engine in-process. This function NEVER throws to callers.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { compressCode, CompressOptions, CompressResult } from './compress';

const WORKER_TIMEOUT_MS = 10_000;
let nextId = 1;
let workerKnownMissing = false;

function workerScriptPath(): string {
  return path.join(__dirname, 'compressionWorker.js');
}

/**
 * Compress code, preferring the worker thread. Resolves with a result in
 * all cases (synchronous fallback included).
 */
export async function compressAsync(
  code: string,
  options: CompressOptions = {},
): Promise<CompressResult> {
  if (!workerKnownMissing) {
    try {
      return await compressInWorker(code, options);
    } catch {
      // fall through to synchronous compression
    }
  }
  return compressCode(code, options);
}

function compressInWorker(
  code: string,
  options: CompressOptions,
): Promise<CompressResult> {
  return new Promise<CompressResult>((resolve, reject) => {
    const script = workerScriptPath();
    if (!fs.existsSync(script)) {
      workerKnownMissing = true;
      reject(new Error(`compression worker not found at ${script}`));
      return;
    }

    let worker: Worker;
    try {
      worker = new Worker(script);
    } catch (err) {
      workerKnownMissing = true;
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const id = nextId++;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        void worker.terminate();
        reject(new Error('compression worker timed out'));
      }
    }, WORKER_TIMEOUT_MS);

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };

    worker.on('message', (msg: { id: number; ok: boolean; result?: CompressResult; error?: string }) => {
      if (!msg || msg.id !== id) {
        return;
      }
      finish(() => {
        if (msg.ok && msg.result) {
          resolve(msg.result);
        } else {
          reject(new Error(msg.error ?? 'compression worker failed'));
        }
      });
    });
    worker.on('error', (err) => {
      finish(() => reject(err));
    });
    worker.on('exit', (exitCode) => {
      if (exitCode !== 0) {
        finish(() => reject(new Error(`compression worker exited with code ${exitCode}`)));
      }
    });

    try {
      worker.postMessage({ id, code, options });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

/** Synchronous escape hatch (used by tests and the LM tool). */
export function compressSync(
  code: string,
  options: CompressOptions = {},
): CompressResult {
  return compressCode(code, options);
}
