// axon: a stateless logic coprocessor for AI agents.
// Routing, admission control and the JSON envelope live here. The sandbox
// itself lives in src/sandbox.ts; the package resolver in src/modules.ts.

import { IpLimiter, Semaphore, hashKey } from './limits';
import { collectImports } from './lexer';
import { ModuleError, loadModules } from './modules';
import { ENGINE, MAX_INTERRUPT_CHECKS, SandboxError, execute } from './sandbox';

export interface Env {
  ASSETS: Fetcher;
  RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

const VERSION = '1.0.0';
const SERVICE = 'axon';

// Date.now() is frozen while the module is evaluated, so the start time is
// captured on the first request.
let startedAt = 0;
function uptimeSeconds(): number {
  const now = Date.now();
  if (startedAt === 0) startedAt = now;
  return Math.floor((now - startedAt) / 1000);
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CODE_BYTES = 32 * 1024;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 1500;
const DEFAULT_TIMEOUT_MS = 750;
const MIN_MEMORY_MB = 4;
const MAX_MEMORY_MB = 32;
const DEFAULT_MEMORY_MB = 16;

const MAX_CONCURRENT = 4;
const MAX_QUEUE = 64;
const MAX_QUEUE_WAIT_MS = 2000;

// Shared-ish limiter. Isolates are not sticky: Cloudflare may serve two
// consecutive requests from two different isolates, which makes a purely
// in-memory bucket almost free to bypass (measured: 60 sequential requests all
// passed). The edge cache is per colo and survives isolate churn, so it is used
// as a best-effort fixed-window counter. It is not atomic; a parallel burst can
// race past it, and that limitation is documented rather than hidden.
// Fixed salt for the shared counter: the key must be identical across isolates,
// so it cannot include the per-isolate salt. It is still a hash, never the raw
// address, and it is never logged.
const RATE_SALT = 'axon-rate-v1';
const WINDOW_MS = 60_000;
const WINDOW_LIMIT = 30;

async function sharedWindow(key: string, ctx: ExecutionContext): Promise<number | null> {
  try {
    const store = (caches as unknown as { default?: Cache }).default;
    if (!store) return null;
    const now = Date.now();
    const window = Math.floor(now / WINDOW_MS);
    const cacheKey = new Request(`https://axon-rate.invalid/${key}/${window}`, { method: 'GET' });
    const hit = await store.match(cacheKey);
    const count = hit ? Number(await hit.text()) : 0;
    if (Number.isFinite(count) && count >= WINDOW_LIMIT) {
      return Math.max(1, Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1000));
    }
    const next = new Response(String((Number.isFinite(count) ? count : 0) + 1), {
      headers: { 'cache-control': 'max-age=120' },
    });
    ctx.waitUntil(store.put(cacheKey, next).catch(() => undefined));
    return null;
  } catch {
    return null;
  }
}

// Per-isolate (per-colo) best effort. Not a global quota: free plan has no
// shared state primitive. Documented on the FAQ and in the meta endpoint.
const limiter = new IpLimiter(10, 0.5);
const semaphore = new Semaphore(MAX_CONCURRENT, MAX_QUEUE);

// Created on the first request: crypto.randomUUID() is not allowed while the
// module is being evaluated, only inside a handler.
let ipSalt: string | null = null;
function salt(): string {
  ipSalt ??= crypto.randomUUID();
  return ipSalt;
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'cross-origin',
};

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-expose-headers': 'x-request-id, retry-after',
  'access-control-max-age': '86400',
};

interface ErrorCode {
  status: number;
  retryAfter?: number;
}

const ERROR_STATUS: Record<string, ErrorCode> = {
  BAD_REQUEST: { status: 400 },
  PAYLOAD_TOO_LARGE: { status: 413 },
  MODULE_NOT_FOUND: { status: 422 },
  EXEC_TIMEOUT: { status: 408 },
  EXEC_ERROR: { status: 422 },
  MEMORY_LIMIT: { status: 422 },
  RATE_LIMITED: { status: 429, retryAfter: 2 },
  BUSY: { status: 503, retryAfter: 2 },
  INTERNAL: { status: 500 },
};

const EXAMPLES = [
  {
    name: 'math',
    description: 'Compound interest, rounded to cents.',
    code: 'const principal = 12000;\nconst rate = 0.045;\nconst years = 7;\nreturn Math.round(principal * Math.pow(1 + rate, years) * 100) / 100;',
  },
  {
    name: 'regex',
    description: 'Pull every ticket id out of a changelog line.',
    code: "const line = 'fix(api): retry POST /jobs (ABC-142, ABC-157)';\nreturn [...line.matchAll(/[A-Z]{3}-\\\\d+/g)].map((m) => m[0]);",
  },
  {
    name: 'date',
    description: 'Business days between two dates, weekends excluded.',
    code: "const start = new Date('2026-01-01');\nconst end = new Date('2026-02-01');\nlet days = 0;\nfor (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {\n  const day = d.getUTCDay();\n  if (day !== 0 && day !== 6) days++;\n}\nreturn days;",
  },
  {
    name: 'lodash',
    description: 'A real npm package, bundled by esm.sh and run in the sandbox.',
    code: "import _ from 'lodash';\nconst rows = [\n  { team: 'core', points: 12 },\n  { team: 'web', points: 7 },\n  { team: 'core', points: 9 },\n];\nexport default _.chain(rows).groupBy('team').mapValues((g) => _.sumBy(g, 'points')).value();",
  },
];

function baseHeaders(requestId: string): Headers {
  const headers = new Headers({
    'x-request-id': requestId,
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...CORS_HEADERS,
  });
  return headers;
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extra?: HeadersInit,
): Response {
  const headers = baseHeaders(requestId);
  headers.set('content-type', 'application/json; charset=utf-8');
  if (extra) {
    const additional = new Headers(extra);
    additional.forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function fail(
  code: keyof typeof ERROR_STATUS,
  message: string,
  requestId: string,
  extra?: Record<string, unknown>,
): Response {
  const meta = ERROR_STATUS[code] ?? ERROR_STATUS.INTERNAL;
  const headers: Record<string, string> = {};
  if (meta.retryAfter !== undefined) {
    headers['retry-after'] = String(meta.retryAfter);
  }
  return jsonResponse(
    {
      ok: false,
      error: { code, message, ...extra },
      request_id: requestId,
    },
    meta.status,
    requestId,
    headers,
  );
}

async function readBodyCapped(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

interface ExecuteBody {
  code?: unknown;
  timeout_ms?: unknown;
  memory_mb?: unknown;
}

async function handleExecute(
  request: Request,
  requestId: string,
  ctx: ExecutionContext,
  env: Env,
): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const bucketKey = hashKey(`${salt()}:${ip}`);
  const limiterKey = hashKey(`${RATE_SALT}:${ip}`);

  // Atomic per-colo limiter first; the cache window is the fallback if the
  // binding is missing (for example in a stripped local dev setup).
  let windowRetry: number | null = null;
  if (env.RATE_LIMITER) {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: limiterKey });
      if (!success) windowRetry = 60;
    } catch {
      windowRetry = await sharedWindow(limiterKey, ctx);
    }
  } else {
    windowRetry = await sharedWindow(limiterKey, ctx);
  }

  if (windowRetry !== null) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: `rate limit reached, retry in ${windowRetry}s (30 requests per 60s per IP)`,
        },
        request_id: requestId,
      },
      429,
      requestId,
      { 'retry-after': String(windowRetry) },
    );
  }

  if (!limiter.take(bucketKey)) {
    const retry = limiter.retryAfter(bucketKey);
    const headers = new Headers({ 'retry-after': String(retry) });
    return jsonResponse(
      {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: `rate limit reached, retry in ${retry}s (per-colo, best effort)`,
        },
        request_id: requestId,
      },
      429,
      requestId,
      headers,
    );
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail('PAYLOAD_TOO_LARGE', 'request body exceeds 64 KB', requestId);
  }

  const raw = await readBodyCapped(request, MAX_BODY_BYTES);
  if (raw === null) {
    return fail('PAYLOAD_TOO_LARGE', 'request body exceeds 64 KB', requestId);
  }
  if (!raw.trim()) {
    return fail('BAD_REQUEST', 'request body is empty, expected JSON', requestId);
  }

  let parsed: ExecuteBody;
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail('BAD_REQUEST', 'request body must be a JSON object', requestId);
    }
    parsed = value as ExecuteBody;
  } catch {
    return fail('BAD_REQUEST', 'request body is not valid JSON', requestId);
  }

  if (typeof parsed.code !== 'string') {
    return fail('BAD_REQUEST', 'field "code" must be a string', requestId);
  }
  const code = parsed.code;
  if (code.length === 0) {
    return fail('BAD_REQUEST', 'field "code" is empty', requestId);
  }
  if (new TextEncoder().encode(code).byteLength > MAX_CODE_BYTES) {
    return fail('PAYLOAD_TOO_LARGE', 'field "code" exceeds 32 KB', requestId);
  }

  const timeoutMs = clamp(parsed.timeout_ms, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const memoryMb = clamp(parsed.memory_mb, MIN_MEMORY_MB, MAX_MEMORY_MB, DEFAULT_MEMORY_MB);

  const scan = collectImports(code);
  let modules: Map<string, string> = new Map();
  let originByUrl: Map<string, string> = new Map();
  let moduleNames: string[] = [];
  if (scan.specifiers.length > 0) {
    try {
      const loaded = await loadModules(scan.specifiers, ctx);
      modules = loaded.map;
      originByUrl = loaded.originByUrl;
      moduleNames = loaded.names;
    } catch (error) {
      if (error instanceof ModuleError) {
        return fail('MODULE_NOT_FOUND', error.message, requestId, { module: error.specifier });
      }
      throw error;
    }
  }

  const release = await semaphore.acquire(MAX_QUEUE_WAIT_MS);
  if (!release) {
    const retry = 1 + Math.floor(Math.random() * 3);
    return jsonResponse(
      {
        ok: false,
        error: {
          code: 'BUSY',
          message: 'all execution slots are busy, retry shortly',
        },
        request_id: requestId,
      },
      503,
      requestId,
      { 'retry-after': String(retry) },
    );
  }

  try {
    const outcome = await execute({
      code,
      isModule: scan.isModule,
      timeoutMs,
      memoryMb,
      modules,
      originByUrl,
    });
    return jsonResponse(
      {
        ok: true,
        result: outcome.result === undefined ? null : outcome.result,
        logs: outcome.logs,
        meta: {
          wall_ms: outcome.wallMs,
          modules: moduleNames,
          engine: ENGINE,
          timeout_ms: timeoutMs,
          memory_mb: memoryMb,
        },
      },
      200,
      requestId,
    );
  } catch (error) {
    if (error instanceof SandboxError) {
      return fail(error.code, error.message, requestId);
    }
    // Should be unreachable: the sandbox converts its own failures.
    console.error('axon internal error', error instanceof Error ? error.message : 'unknown');
    return fail('INTERNAL', 'internal error, the request was not executed', requestId);
  } finally {
    release();
  }
}

function methodNotAllowed(requestId: string, allow: string): Response {
  return jsonResponse(
    {
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'method not allowed, use POST' },
      request_id: requestId,
    },
    405,
    requestId,
    { allow },
  );
}

async function staticNotFound(request: Request, env: Env, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = '/404.html';
  url.search = '';
  const asset = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
  const headers = new Headers(asset.headers);
  headers.set('x-request-id', requestId);
  headers.set('cache-control', 'no-store');
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(request.method === 'HEAD' ? null : asset.body, { status: 404, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: baseHeaders(requestId) });
      }

      const url = new URL(request.url);
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

      switch (path) {
        case '/health':
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            return methodNotAllowed(requestId, 'GET');
          }
          return jsonResponse(
            {
              ok: true,
              service: SERVICE,
              version: VERSION,
              engine: ENGINE,
              uptime_s: uptimeSeconds(),
            },
            200,
            requestId,
          );

        case '/api/v1/meta':
          if (request.method !== 'GET') return methodNotAllowed(requestId, 'GET');
          return jsonResponse(
            {
              ok: true,
              service: SERVICE,
              version: VERSION,
              engine: ENGINE,
              license: 'MIT',
              endpoints: {
                execute: 'POST /api/v1/execute',
                health: 'GET /health',
                examples: 'GET /api/v1/examples',
              },
              limits: {
                cpu_ms_free_plan: 10,
                interrupt_budget_checks: MAX_INTERRUPT_CHECKS,
                default_deadline_ms: DEFAULT_TIMEOUT_MS,
                max_deadline_ms: MAX_TIMEOUT_MS,
                min_deadline_ms: MIN_TIMEOUT_MS,
                default_heap_mb: DEFAULT_MEMORY_MB,
                max_heap_mb: MAX_MEMORY_MB,
                max_body_bytes: MAX_BODY_BYTES,
                max_code_bytes: MAX_CODE_BYTES,
                max_modules: 10,
                max_module_bytes: 1024 * 1024,
                concurrent_per_isolate: MAX_CONCURRENT,
                queue_depth: MAX_QUEUE,
                rate_limit:
                  '30 req / 60 s per IP per location (best effort) plus a burst bucket of 10 per isolate; soft when requests spread across isolates',
              },
              sandbox: {
                filesystem: false,
                network: false,
                state_between_calls: false,
                retention: 'none',
              },
            },
            200,
            requestId,
          );

        case '/api/v1/examples':
          if (request.method !== 'GET') return methodNotAllowed(requestId, 'GET');
          return jsonResponse({ ok: true, examples: EXAMPLES }, 200, requestId);

        case '/api/v1/execute':
          if (request.method !== 'POST') return methodNotAllowed(requestId, 'POST');
          return await handleExecute(request, requestId, ctx, env);

        default:
          return await staticNotFound(request, env, requestId);
      }
    } catch (error) {
      console.error('axon unhandled', error instanceof Error ? error.message : 'unknown');
      return fail('INTERNAL', 'internal error, the request was not executed', requestId);
    }
  },
};

// Keep unhandled rejections away from the runtime's default error page.
addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
});
