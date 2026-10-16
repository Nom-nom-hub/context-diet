/**
 * Worker-thread entry point. Loaded as `compressionWorker.js` next to
 * the compiled `astParser.js`. Communicates via parentPort messages:
 *   in : { id: number, code: string, options: CompressOptions }
 *   out: { id: number, ok: true, result: CompressResult }
 *        { id: number, ok: false, error: string }
 */
import { parentPort } from 'worker_threads';
import { compressCode, CompressOptions } from './compress';

interface CompressRequest {
  id: number;
  code: string;
  options?: CompressOptions;
}

if (parentPort) {
  parentPort.on('message', (msg: CompressRequest) => {
    try {
      const result = compressCode(msg.code, msg.options ?? {});
      parentPort!.postMessage({ id: msg.id, ok: true, result });
    } catch (err) {
      parentPort!.postMessage({
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
