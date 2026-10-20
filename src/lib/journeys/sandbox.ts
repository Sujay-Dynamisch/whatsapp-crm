// ============================================================
// Code step sandbox (migration 054).
//
// Account-written JavaScript runs inside QuickJS compiled to
// WebAssembly — a separate JS engine with its own heap. It cannot
// reach Node (no require, process, fs, network, timers); the only
// thing that crosses the boundary is a JSON copy of the step's input
// going in and a JSON string coming out. Node's own `vm` module is NOT
// a sandbox and must not be used for this.
//
// Each run gets a fresh QuickJS runtime with memory / stack caps and
// an interrupt deadline. The deadline is only checked between
// bytecodes, though: code that drives QuickJS into GC thrash near its
// memory cap can sit in native code for seconds. So the run happens in
// a worker thread that is terminated at a hard wall-clock limit — a
// hostile step can fail itself but never stall the server. Where a
// worker can't load QuickJS from node_modules (e.g. a bundle without
// it), we fall back to running in-process with the same caps.
//
// The single-file variant embeds the WASM binary in JS, so nothing
// else needs to be shipped.
// ============================================================

import { Worker } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core';
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-cjs-release-sync';

export interface CodeResult {
  result: unknown;
  logs: string[];
}

export interface SandboxLimits {
  timeoutMs?: number;
  memoryBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
const STACK_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_LOGS = 50;
/** Extra time a worker gets for startup before it is killed. */
const WORKER_GRACE_MS = 1_500;

/** The script QuickJS evaluates: user code wrapped as a function body. */
function buildSource(code: string, input: Record<string, unknown>): string {
  // The input is embedded as a JSON string literal and parsed inside
  // the sandbox — no host objects or functions are ever passed in.
  return `
    'use strict';
    const $input = JSON.parse(${JSON.stringify(JSON.stringify(input ?? {}))});
    const { contact, trigger, nodes, vars, reply, item, index } = $input;
    const __logs = [];
    const console = {
      log: (...a) => { if (__logs.length < ${MAX_LOGS}) __logs.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); },
    };
    console.error = console.warn = console.info = console.log;
    const __result = (function () {
${code}
    })();
    JSON.stringify({ result: __result === undefined ? null : __result, logs: __logs });
  `;
}

function parseOutput(out: unknown): CodeResult {
  if (typeof out !== 'string') throw new Error('Code must return a JSON-serialisable value');
  if (out.length > MAX_OUTPUT_CHARS) throw new Error('Code returned more than 256 KB of data');
  const parsed = JSON.parse(out) as CodeResult;
  return { result: parsed.result, logs: Array.isArray(parsed.logs) ? parsed.logs : [] };
}

function friendly(message: string): Error {
  return new Error(/interrupted/i.test(message) ? 'Code took too long and was stopped' : message);
}

// ------------------------------------------------------------------
// Worker path (preferred)
// ------------------------------------------------------------------

// Runs inside the worker. An eval worker resolves modules from the
// process's working directory. The core is loaded with import() — the
// server itself uses its ESM build, so that is the file the standalone
// output ships; the variant only has a CommonJS build.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  let core, variant;
  try {
    core = await import('quickjs-emscripten-core');
    const v = require('@jitl/quickjs-singlefile-cjs-release-sync');
    variant = v.default || v;
  } catch (e) {
    parentPort.postMessage({ kind: 'unavailable', message: String(e && e.message || e) });
    return;
  }
  try {
    const QuickJS = await core.newQuickJSWASMModuleFromVariant(variant);
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(workerData.memoryBytes);
    runtime.setMaxStackSize(workerData.stackBytes);
    runtime.setInterruptHandler(core.shouldInterruptAfterDeadline(Date.now() + workerData.timeoutMs));
    const vm = runtime.newContext();
    const res = vm.evalCode(workerData.source, 'step.js');
    if (res.error) {
      const err = vm.dump(res.error);
      res.error.dispose();
      const msg = typeof err === 'string' ? err : ((err && err.name) || 'Error') + ': ' + ((err && err.message) || 'unknown error');
      parentPort.postMessage({ kind: 'error', message: msg });
    } else {
      const out = vm.getString(res.value);
      res.value.dispose();
      parentPort.postMessage({ kind: 'ok', out });
    }
    vm.dispose();
    runtime.dispose();
  } catch (e) {
    parentPort.postMessage({ kind: 'error', message: String(e && e.message || e) });
  }
})();
`;

type WorkerReply = { kind: 'ok'; out: string } | { kind: 'error'; message: string } | { kind: 'unavailable'; message: string };

function runInWorker(source: string, timeoutMs: number, memoryBytes: number): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { source, timeoutMs, memoryBytes, stackBytes: STACK_BYTES },
        // Bound the worker's own V8 heap too (QuickJS lives in WASM memory).
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
        stdout: true,
        stderr: true,
      });
    } catch (err) {
      resolve({ kind: 'unavailable', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('Code took too long and was stopped'))),
      timeoutMs + WORKER_GRACE_MS
    );
    worker.once('message', (msg: WorkerReply) => finish(() => resolve(msg)));
    worker.once('error', (err: Error) => finish(() => reject(friendly(err.message))));
    worker.once('exit', (code) =>
      finish(() => reject(new Error(code === 0 ? 'Code ended without a result' : 'Code ran out of memory and was stopped')))
    );
  });
}

// ------------------------------------------------------------------
// In-process fallback
// ------------------------------------------------------------------

let modulePromise: Promise<QuickJSWASMModule> | null = null;

async function runInProcess(source: string, timeoutMs: number, memoryBytes: number): Promise<string> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  const QuickJS = await modulePromise;
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryBytes);
  runtime.setMaxStackSize(STACK_BYTES);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
  const vm = runtime.newContext();
  try {
    const res = vm.evalCode(source, 'step.js');
    if (res.error) {
      const err = vm.dump(res.error) as { name?: string; message?: string } | string;
      res.error.dispose();
      throw friendly(typeof err === 'string' ? err : `${err?.name ?? 'Error'}: ${err?.message ?? 'unknown error'}`);
    }
    const out = vm.getString(res.value);
    res.value.dispose();
    return out;
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

let workerUnavailable = false;

/**
 * Run `code` as the body of a function whose return value becomes the
 * step output. `input` is exposed as `$input` and destructured into
 * `contact`, `trigger`, `nodes`, `vars`, `reply`, `item`, `index`.
 * `console.log` output is captured. Throws on error / timeout.
 */
export async function runUserCode(
  code: string,
  input: Record<string, unknown>,
  limits: SandboxLimits = {}
): Promise<CodeResult> {
  const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryBytes = limits.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  const source = buildSource(code, input);

  if (!workerUnavailable) {
    const reply = await runInWorker(source, timeoutMs, memoryBytes);
    if (reply.kind === 'ok') return parseOutput(reply.out);
    if (reply.kind === 'error') throw friendly(reply.message);
    workerUnavailable = true;
    console.warn('[journeys/sandbox] worker unavailable, running code in-process:', reply.message);
  }
  return parseOutput(await runInProcess(source, timeoutMs, memoryBytes));
}
