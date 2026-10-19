// The sandbox: one QuickJS runtime per request, a hard wall-clock deadline, a
// hard heap ceiling, and a synchronous module loader fed by src/modules.ts.
//
// Everything here is disposed by hand. quickjs-emscripten wraps every value in
// a handle owned by the runtime, and the wasm heap is only given back when the
// handles, the context and the runtime are freed in that order. A leaked handle
// does not crash the request; it quietly grows the isolate, so the dispose
// calls below are load-bearing, not hygiene.

import variant from '@jitl/quickjs-wasmfile-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSWASMModule,
  type QuickJSRuntime,
  type VmCallResult,
  type QuickJSHandle,
} from 'quickjs-emscripten';
// Imported with a literal path ending in .wasm: wrangler's module rule matches
// the import specifier, not the resolved package export, so a bare package
// subpath would reach esbuild with no loader.
import wasmModule from '../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm';

import { makeLoader } from './modules';

export const ENGINE = 'quickjs 2025-09-13 (bellard)';

// Inside a Worker, the clock does not advance during a synchronous call: both
// Date.now() and performance.now() are frozen for the duration of the eval, so
// a wall-clock deadline alone can never interrupt an infinite loop. QuickJS
// calls the interrupt handler every few thousand bytecode instructions; that
// count is the only reliable CPU proxy available here. The measured relation
// on this build is roughly 0.25 ms of wasm CPU per check, so 1200 checks cut a
// runaway loop at about 300 ms, well below the platform kill of 2 s and well
// above a legitimate lodash parse (tens of checks).
export const MAX_INTERRUPT_CHECKS = 1200;

// Kept as a secondary ceiling: it fires in wrangler dev and in Node, where the
// clock does advance, and it costs nothing in production.
const CPU_GUARD_MS = 8;

const MAX_RESULT_BYTES = 256 * 1024;
const RESULT_SENTINEL_UNDEFINED = '__axon_undefined__';
const RESULT_SENTINEL_CYCLE = '__axon_unserializable__';

export type SandboxErrorCode = 'EXEC_TIMEOUT' | 'EXEC_ERROR' | 'MEMORY_LIMIT' | 'MODULE_NOT_FOUND';

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export interface ExecuteOptions {
  code: string;
  isModule: boolean;
  timeoutMs: number;
  memoryMb: number;
  modules: Map<string, string>;
  originByUrl: Map<string, string>;
}

export interface ExecuteResult {
  result: unknown;
  logs: string[];
  wallMs: number;
}

// The wasm module is compiled once per isolate at startup, never per request.
const syncVariant = newVariant(variant, {
  wasmModule: wasmModule as unknown as WebAssembly.Module,
});

let quickjsPromise: Promise<QuickJSWASMModule> | null = null;

function getQuickJS(): Promise<QuickJSWASMModule> {
  quickjsPromise ??= newQuickJSWASMModuleFromVariant(syncVariant);
  return quickjsPromise;
}

const PRELUDE = `(function () {
  var logs = [];
  globalThis.__axon_logs = logs;
  function fmt(value) {
    if (typeof value === 'string') return value;
    try {
      var json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch (error) {
      return String(value);
    }
  }
  function push(prefix) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
      var line = prefix + parts.join(' ');
      logs.push(line.slice(0, 2000));
      if (logs.length > 50) logs.shift();
    };
  }
  globalThis.console = {
    log: push(''),
    info: push(''),
    debug: push(''),
    warn: push('warn: '),
    error: push('error: '),
  };
  globalThis.process = undefined;
  globalThis.require = undefined;
})();`;

function disposeQuietly(handle: QuickJSHandle | undefined): void {
  if (handle && handle.alive) handle.dispose();
}

function disposeResult(result: VmCallResult<QuickJSHandle> | null | undefined): void {
  if (!result) return;
  if (result.error) disposeQuietly(result.error);
  else disposeQuietly(result.value);
}

function readString(context: QuickJSContext, handle: QuickJSHandle): string | undefined {
  if (context.typeof(handle) !== 'string') return undefined;
  return context.getString(handle);
}

function errorMessage(context: QuickJSContext, handle: QuickJSHandle): string {
  let message = '';
  const type = context.typeof(handle);
  if (type === 'object' || type === 'function') {
    const prop = context.getProp(handle, 'message');
    message = readString(context, prop) ?? '';
    disposeQuietly(prop);
  }
  if (!message) message = String(context.dump(handle));
  return message;
}

function classify(message: string): SandboxErrorCode {
  if (/interrupted/i.test(message)) return 'EXEC_TIMEOUT';
  if (/out of memory|memory limit|allocation failed/i.test(message)) return 'MEMORY_LIMIT';
  if (/MODULE_NOT_FOUND/.test(message)) return 'MODULE_NOT_FOUND';
  return 'EXEC_ERROR';
}

function cleanMessage(
  code: SandboxErrorCode,
  raw: string,
  originByUrl: Map<string, string>,
): string {
  if (code === 'EXEC_TIMEOUT')
    return 'execution exceeded the CPU budget: the sandbox stops after a fixed instruction budget so you get this JSON error instead of a platform 1102';
  if (code === 'MEMORY_LIMIT') return 'execution exceeded the memory limit';
  if (code === 'MODULE_NOT_FOUND') {
    const token = raw.split('MODULE_NOT_FOUND')[1]?.trim().split(/\s/)[0] ?? '';
    const named = originByUrl.get(token) ?? token.replace(/^https?:\/\/esm\.sh\//, '');
    return `cannot resolve module "${named || 'unknown'}"`;
  }
  // First line only, bounded: stack traces and wasm addresses never leave here.
  return raw.split('\n')[0].slice(0, 300) || 'execution failed';
}

/**
 * Run untrusted code. Always disposes the context and the runtime, including on
 * timeout, OOM and wasm traps.
 */
export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
  const quickjs = await getQuickJS();
  // performance.now() is monotonic and advances during synchronous execution;
  // Date.now() is too coarse here to report a sub-millisecond wall time.
  const started = performance.now();
  // Two ceilings, whichever comes first: the caller's deadline and the CPU
  // guard that keeps us under the platform's 10 ms limit.
  const deadline = started + Math.min(options.timeoutMs, CPU_GUARD_MS);

  // One runtime per request. A runtime is a fresh wasm heap: no globals, no
  // module registry and no memory survive from the previous call.
  const runtime: QuickJSRuntime = quickjs.newRuntime();
  runtime.setMemoryLimit(options.memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  let checks = 0;
  let timedOutBy: 'clock' | 'checks' | null = null;
  runtime.setInterruptHandler(() => {
    checks++;
    if (checks > MAX_INTERRUPT_CHECKS) {
      timedOutBy = 'checks';
      return true;
    }
    // performance.now() is not free, and QuickJS calls this handler very
    // often. Sampling it every 64 checks keeps the handler cheap; the counter
    // above is the primary guard.
    if ((checks & 63) === 0 && performance.now() > deadline) {
      timedOutBy = 'clock';
      return true;
    }
    return false;
  });

  const { loader, normalizer } = makeLoader(options.modules, options.originByUrl);
  runtime.setModuleLoader(loader, normalizer);

  // Handles created by this request. Disposed in reverse creation order before
  // the context, because a child handle must not outlive its parent.
  const handles: QuickJSHandle[] = [];
  const context: QuickJSContext = runtime.newContext();

  try {
    // Attach the log ring buffer and drop host-ish globals before user code.
    disposeResult(context.evalCode(PRELUDE, 'axon:prelude.js'));

    const source = options.isModule ? options.code : `(function () {\n${options.code}\n})()`;
    const filename = options.isModule ? 'axon:user.mjs' : 'axon:user.js';

    let evaluated: VmCallResult<QuickJSHandle>;
    try {
      evaluated = context.evalCode(source, filename, {
        type: options.isModule ? 'module' : 'global',
      });
    } catch (error) {
      // A wasm trap or an internal QuickJS failure still has to leave as JSON.
      throw new SandboxError('EXEC_ERROR', String(error).slice(0, 300));
    }

    if (evaluated.error) {
      const raw = errorMessage(context, evaluated.error);
      disposeQuietly(evaluated.error);
      const code = classify(raw);
      if (code === 'EXEC_TIMEOUT') {
        // Diagnostics only, visible in `wrangler tail`, never in the response.
        console.log(`axon timeout by=${timedOutBy ?? 'unknown'} checks=${checks}`);
      }
      throw new SandboxError(code, cleanMessage(code, raw, options.originByUrl));
    }

    const value = evaluated.value;
    handles.push(value);

    // A module with top-level await resolves to a promise. The sync runtime
    // cannot drain the job queue against a real clock, so refuse it clearly.
    const state = context.getPromiseState(value) as {
      type: 'pending' | 'fulfilled' | 'rejected';
      notAPromise?: boolean;
      value?: QuickJSHandle;
      error?: QuickJSHandle;
    };
    let namespace = value;
    if (!state.notAPromise) {
      if (state.type === 'pending') {
        throw new SandboxError('EXEC_ERROR', 'top-level await is not supported');
      }
      if (state.type === 'rejected') {
        const rejection = state.error!;
        handles.push(rejection);
        const raw = errorMessage(context, rejection);
        const code = classify(raw);
        throw new SandboxError(code, cleanMessage(code, raw, options.originByUrl));
      }
      namespace = state.value ?? value;
      handles.push(namespace);
    }

    let resultHandle: QuickJSHandle;
    if (options.isModule) {
      resultHandle = context.getProp(namespace, 'default');
      if (context.typeof(resultHandle) === 'undefined') {
        disposeQuietly(resultHandle);
        throw new SandboxError('EXEC_ERROR', 'module has no default export');
      }
      handles.push(resultHandle);
    } else {
      // The script wrapper returned the value directly; `namespace` already
      // lives in `handles`, so it is not pushed twice.
      resultHandle = namespace;
    }

    // Serialise inside the VM: cycles, BigInt and getters cannot throw the
    // request, and the 256 KB cap is applied to the produced string.
    context.setProp(context.global, '__axon_result', resultHandle);
    const serialised = context.evalCode(
      `(function () {
        try {
          var json = JSON.stringify(globalThis.__axon_result);
          return json === undefined ? ${JSON.stringify(RESULT_SENTINEL_UNDEFINED)} : json;
        } catch (error) {
          return ${JSON.stringify(RESULT_SENTINEL_CYCLE)};
        }
      })()`,
      'axon:serialise.js',
    );

    if (serialised.error) {
      const raw = errorMessage(context, serialised.error);
      disposeQuietly(serialised.error);
      const code = classify(raw);
      throw new SandboxError(code, cleanMessage(code, raw, options.originByUrl));
    }

    const text = context.getString(serialised.value) ?? '';
    disposeQuietly(serialised.value);

    let result: unknown;
    if (text === RESULT_SENTINEL_UNDEFINED) {
      result = undefined;
    } else if (text === RESULT_SENTINEL_CYCLE) {
      throw new SandboxError('EXEC_ERROR', 'result is not JSON-serialisable');
    } else {
      if (text.length > MAX_RESULT_BYTES) {
        throw new SandboxError('EXEC_ERROR', 'result exceeds 256 KB');
      }
      result = JSON.parse(text);
    }

    // Logs are read after user code, so a crash still returns what was printed.
    const logsResult = context.evalCode('JSON.stringify(globalThis.__axon_logs)', 'axon:logs.js');
    let logs: string[] = [];
    if (logsResult.error) {
      disposeQuietly(logsResult.error);
    } else {
      const logsText = context.getString(logsResult.value) ?? '[]';
      disposeQuietly(logsResult.value);
      try {
        const parsed = JSON.parse(logsText);
        if (Array.isArray(parsed)) logs = parsed.filter((line) => typeof line === 'string');
      } catch {
        logs = [];
      }
    }

    // Workers freezes Date.now() and performance.now() for the duration of a
    // request (they only advance at I/O boundaries), so this reads 0 for a
    // pure CPU call. It is still reported for clients that want it, and the
    // client-side elapsed time is the honest number. See README, "wall_ms".
    return { result, logs, wallMs: Math.round((performance.now() - started) * 10) / 10 };
  } finally {
    // Reverse order: last created handle first, then the context that owns the
    // global object, then the runtime that owns the heap.
    for (let i = handles.length - 1; i >= 0; i--) disposeQuietly(handles[i]);
    context.dispose();
    runtime.dispose();
  }
}
