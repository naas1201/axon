// Resolve packages outside the sandbox, evaluate them inside it.
//
// The sync QuickJS runtime has a synchronous module loader, so every byte it
// may ask for has to be in memory before evaluation starts. This module walks
// the import graph over HTTP (esm.sh, bundled), then hands the resulting
// Map<string, string> to the sandbox.

import { collectImports } from './lexer';

export const ESM_BASE = 'https://esm.sh/';
const MAX_MODULES = 10;
const MAX_GRAPH_BYTES = 1_000_000;
const MAX_MODULE_BYTES = 512_000;
const MAX_DEPTH = 2;
const FETCH_TIMEOUT_MS = 4000;
const MEM_CACHE_ENTRIES = 24;

export class ModuleError extends Error {
  constructor(
    message: string,
    readonly specifier: string,
  ) {
    super(message);
    this.name = 'ModuleError';
  }
}

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
]);

export function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  return NODE_BUILTINS.has(specifier.split('/')[0]);
}

/** Turn a bare specifier into a bundled esm.sh URL. */
export function packageUrl(specifier: string): string {
  if (/^https?:\/\//.test(specifier)) return specifier;
  if (specifier.startsWith('/')) return ESM_BASE.slice(0, -1) + specifier;
  const joiner = specifier.includes('?') ? '&' : '?';
  return `${ESM_BASE}${specifier}${joiner}bundle&target=es2022`;
}

/** Resolve a specifier found inside `baseUrl` (or in user code for entry). */
export function resolveSpecifier(baseUrl: string, specifier: string): string | null {
  if (!specifier) return null;
  if (specifier.startsWith('data:')) return null;
  if (/^https?:\/\//.test(specifier)) return specifier;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return new URL(specifier, baseUrl).href;
  }
  if (specifier.startsWith('/')) return ESM_BASE.slice(0, -1) + specifier;
  return packageUrl(specifier);
}

const memoryCache = new Map<string, string>();

function memoryGet(url: string): string | undefined {
  const hit = memoryCache.get(url);
  if (hit === undefined) return undefined;
  memoryCache.delete(url);
  memoryCache.set(url, hit);
  return hit;
}

function memorySet(url: string, source: string): void {
  memoryCache.set(url, source);
  while (memoryCache.size > MEM_CACHE_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function cacheStorage(): Cache | null {
  try {
    if (typeof caches === 'undefined') return null;
    const store = (caches as unknown as { default?: Cache }).default;
    return store ?? null;
  } catch {
    return null;
  }
}

async function fetchModule(url: string, ctx?: ExecutionContext): Promise<string> {
  const fromMemory = memoryGet(url);
  if (fromMemory !== undefined) return fromMemory;

  const cache = cacheStorage();
  const cacheKey = new Request(url, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const text = await hit.text();
        memorySet(url, text);
        return text;
      }
    } catch {
      // Cache is an optimisation; fall through to the network.
    }
  }

  let lastError: ModuleError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const jitter = Math.floor(Math.random() * 120);
      await sleep(140 * 2 ** (attempt - 1) + jitter);
    }
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'axon/1.0 (+https://axon.va-n.com)' },
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new ModuleError(`esm.sh returned ${response.status}`, url);
        continue;
      }
      if (!response.ok) {
        throw new ModuleError(`esm.sh returned ${response.status}`, url);
      }
      const text = await response.text();
      if (byteLength(text) > MAX_MODULE_BYTES) {
        throw new ModuleError('module exceeds the 512 KB limit', url);
      }
      memorySet(url, text);
      if (cache && ctx) {
        const cacheable = new Response(text, {
          headers: {
            'cache-control': 'public, max-age=3600',
            'content-type': 'application/javascript; charset=utf-8',
          },
        });
        ctx.waitUntil(cache.put(cacheKey, cacheable).catch(() => undefined));
      }
      return text;
    } catch (error) {
      if (error instanceof ModuleError) throw error;
      lastError = new ModuleError('could not reach esm.sh', url);
    }
  }
  throw lastError ?? new ModuleError('could not resolve module', url);
}

export interface LoadedModules {
  map: Map<string, string>;
  /** Root package specifiers, echoed in the response meta. */
  names: string[];
  /** URL to the human-readable specifier that first required it. */
  originByUrl: Map<string, string>;
  bytes: number;
}

/**
 * Fetch the bundled closure for every root specifier. Throws ModuleError with
 * the offending specifier so the API can answer MODULE_NOT_FOUND instead of a
 * 500.
 */
export async function loadModules(
  specifiers: string[],
  ctx?: ExecutionContext,
): Promise<LoadedModules> {
  const map = new Map<string, string>();
  const originByUrl = new Map<string, string>();
  const names: string[] = [];
  const queue: Array<{ url: string; depth: number; specifier: string }> = [];
  let bytes = 0;

  for (const specifier of specifiers) {
    if (isNodeBuiltin(specifier)) {
      throw new ModuleError(
        `"${specifier}" is a Node.js builtin and is not available in the sandbox`,
        specifier,
      );
    }
    const url = packageUrl(specifier);
    names.push(specifier);
    originByUrl.set(url, specifier);
    queue.push({ url, depth: 0, specifier });
  }

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (map.has(next.url)) continue;
    if (map.size >= MAX_MODULES) {
      throw new ModuleError('import graph exceeds 10 modules', next.specifier);
    }

    const source = await fetchModule(next.url, ctx).catch((error: unknown) => {
      if (error instanceof ModuleError) {
        throw new ModuleError(
          `cannot resolve "${next.specifier}": ${error.message}`,
          next.specifier,
        );
      }
      throw error;
    });
    bytes += byteLength(source);
    if (bytes > MAX_GRAPH_BYTES) {
      throw new ModuleError('import graph exceeds 1 MB', next.specifier);
    }
    map.set(next.url, source);
    if (!originByUrl.has(next.url)) originByUrl.set(next.url, next.specifier);

    if (next.depth >= MAX_DEPTH) continue;
    const scan = collectImports(source);
    for (const inner of scan.specifiers) {
      if (isNodeBuiltin(inner)) {
        throw new ModuleError(
          `"${inner}" is a Node.js builtin and is not available in the sandbox`,
          inner,
        );
      }
      const resolved = resolveSpecifier(next.url, inner);
      if (!resolved) {
        throw new ModuleError(`cannot resolve "${inner}"`, inner);
      }
      if (!map.has(resolved)) {
        if (!originByUrl.has(resolved)) originByUrl.set(resolved, inner);
        queue.push({ url: resolved, depth: next.depth + 1, specifier: inner });
      }
    }
  }

  return { map, names, originByUrl, bytes };
}

/** Synchronous loader/normalizer pair handed to the QuickJS runtime. */
export function makeLoader(map: Map<string, string>, originByUrl: Map<string, string>) {
  const loader = (name: string): string => {
    const source = map.get(name);
    if (source === undefined) {
      throw new Error(`MODULE_NOT_FOUND ${name} ${originByUrl.get(name) ?? ''}`.trim());
    }
    return source;
  };
  const normalizer = (base: string, specifier: string): string => {
    const resolved = resolveSpecifier(base, specifier);
    if (!resolved) throw new Error(`MODULE_NOT_FOUND ${specifier}`);
    return resolved;
  };
  return { loader, normalizer };
}
