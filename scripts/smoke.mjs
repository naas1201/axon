#!/usr/bin/env node
// Live smoke test for axon.
//
//   node scripts/smoke.mjs                       # against https://axon.va-n.com
//   node scripts/smoke.mjs http://127.0.0.1:8789 # against a local wrangler dev
//
// Prints a pass/fail table and exits non-zero if anything fails. Sequential
// requests are retried once on 429/503 so the rate limiter does not turn a
// functional test into a false negative; the parallel burst is not retried,
// because its whole point is to observe the limiter.

const arg = process.argv[2];
const base = (
  arg === '--workers-dev' ? 'https://axon.qmpro.workers.dev' : (arg ?? 'https://axon.va-n.com')
).replace(/\/+$/, '');
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name.padEnd(38)} ${detail}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(body, extraHeaders = {}, retry = true) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${base}/api/v1/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body,
    });
    if (retry && (response.status === 429 || response.status === 503)) {
      const wait = Number(response.headers.get('retry-after') ?? '2');
      await sleep((wait + 0.3) * 1000);
      continue;
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  }
  return { status: 0, json: null, text: 'gave up after retries', headers: new Headers() };
}

function hasStackLeak(text) {
  return /\n\s+at\s|\.ts:\d+|wasm:\/\//.test(text);
}

async function scenario(name, code, check, options = {}) {
  const started = Date.now();
  const result = await post(
    JSON.stringify({ code, ...options.body }),
    options.headers,
    options.retry !== false,
  );
  const elapsed = Date.now() - started;
  const verdict = check(result);
  record(
    name,
    verdict.ok,
    `${result.status} in ${elapsed} ms${verdict.note ? ` · ${verdict.note}` : ''}`,
  );
  if (!verdict.ok) console.log('      body:', result.text.slice(0, 300));
  return result;
}

const ok200 = (r) => ({ ok: r.status === 200 && r.json?.ok === true });
const expect = (status, code) => (r) => ({
  ok: r.status === status && r.json?.ok === false && r.json?.error?.code === code,
  note: r.json?.error?.code,
});

console.log(`axon smoke test against ${base}`);
console.log('');

const math = await scenario(
  'math',
  'return Math.round(12000 * Math.pow(1.045, 7) * 100) / 100',
  (r) => ({
    ok: ok200(r).ok && Math.abs(r.json.result - 16330.34) < 0.011,
    note: String(r.json?.result),
  }),
);

await scenario('string', 'return ("axon" + " " + "works").toUpperCase()', (r) => ({
  ok: ok200(r).ok && r.json.result === 'AXON WORKS',
  note: r.json?.result,
}));

await scenario(
  'regex',
  'const s = "ABC-142 ABC-157"; return [...s.matchAll(/[A-Z]{3}-\\d+/g)].map(m => m[0])',
  (r) => ({
    ok: ok200(r).ok && r.json.result?.length === 2 && r.json.result[0] === 'ABC-142',
    note: JSON.stringify(r.json?.result),
  }),
);

await scenario('date', 'return new Date("2026-01-01T00:00:00Z").toISOString()', (r) => ({
  ok: ok200(r).ok && r.json.result === '2026-01-01T00:00:00.000Z',
  note: r.json?.result,
}));

await scenario(
  'lodash package',
  'import _ from "lodash"; export default _.chunk([1,2,3,4,5], 2)',
  (r) => ({
    ok:
      ok200(r).ok &&
      Array.isArray(r.json.result) &&
      JSON.stringify(r.json.result) === '[[1,2],[3,4],[5]]' &&
      r.json.meta.modules.length > 0,
    note: `modules=${JSON.stringify(r.json?.meta?.modules)} wall=${r.json?.meta?.wall_ms}`,
  }),
);

await scenario(
  'infinite loop',
  'while (true) {}',
  (r) => ({
    ok: r.status === 408 && r.json?.error?.code === 'EXEC_TIMEOUT' && !hasStackLeak(r.text),
    note: r.json?.error?.code,
  }),
  { body: { timeout_ms: 300 } },
);

await scenario(
  '512 MB allocation',
  'return new Uint8Array(512 * 1024 * 1024).length',
  (r) => ({
    ok:
      r.status === 422 &&
      (r.json?.error?.code === 'MEMORY_LIMIT' || r.json?.error?.code === 'EXEC_ERROR') &&
      !hasStackLeak(r.text),
    note: r.json?.error?.code,
  }),
  { body: { memory_mb: 16 } },
);

await scenario(
  'bogus package',
  'import x from "this-package-does-not-exist-xyz-9"; export default x',
  (r) => ({
    ok:
      r.status === 422 &&
      r.json?.error?.code === 'MODULE_NOT_FOUND' &&
      r.json?.error?.message?.includes('this-package-does-not-exist-xyz-9') &&
      !hasStackLeak(r.text),
    note: r.json?.error?.message?.slice(0, 80),
  }),
);

await scenario('node:fs refused', 'import fs from "node:fs"; export default fs', (r) => ({
  ok:
    r.status === 422 &&
    r.json?.error?.code === 'MODULE_NOT_FOUND' &&
    /builtin|not available/i.test(r.json?.error?.message ?? ''),
  note: r.json?.error?.message,
}));

const empty = await post('', {}, true);
record(
  'empty body',
  empty.status === 400 && empty.json?.error?.code === 'BAD_REQUEST',
  `${empty.status} ${empty.json?.error?.code}`,
);

const badJson = await post('{"code": ', {}, true);
record(
  'malformed JSON',
  badJson.status === 400 && badJson.json?.error?.code === 'BAD_REQUEST',
  `${badJson.status} ${badJson.json?.error?.code}`,
);

const badType = await post('{"code":123}', {}, true);
record(
  'code is a number',
  badType.status === 400 && badType.json?.error?.code === 'BAD_REQUEST',
  `${badType.status} ${badType.json?.error?.code}`,
);

const bigBody = await post(
  JSON.stringify({ code: 'return 1', pad: 'x'.repeat(200 * 1024) }),
  {},
  true,
);
record(
  '200 KB body',
  bigBody.status === 413 && bigBody.json?.error?.code === 'PAYLOAD_TOO_LARGE',
  `${bigBody.status} ${bigBody.json?.error?.code}`,
);

const getExecute = await fetch(`${base}/api/v1/execute`);
const getBody = await getExecute.json().catch(() => null);
record(
  'GET /api/v1/execute',
  getExecute.status === 405 && getBody?.ok === false,
  `${getExecute.status} allow=${getExecute.headers.get('allow')}`,
);

const options = await fetch(`${base}/api/v1/execute`, { method: 'OPTIONS' });
record(
  'CORS preflight',
  options.status === 204 && options.headers.get('access-control-allow-origin') === '*',
  `${options.status} max-age=${options.headers.get('access-control-max-age')}`,
);

// Deliberate burst: no retries, we want to see the limiter answer.
const startedBurst = Date.now();
const burst = await Promise.all(
  Array.from({ length: 25 }, (_, i) =>
    post(JSON.stringify({ code: `return ${i}` }), {}, false).then((r) => r.status),
  ),
);
const okCount = burst.filter((s) => s === 200).length;
const limited = burst.filter((s) => s === 429 || s === 503).length;
record(
  '25 parallel requests',
  okCount > 0 && limited > 0 && !burst.includes(500) && !burst.includes(1102),
  `${Date.now() - startedBurst} ms · 200=${okCount} 429/503=${limited}`,
);

const health = await fetch(`${base}/health`);
const healthJson = await health.json().catch(() => null);
record(
  'health after burst',
  health.status === 200 && healthJson?.ok === true,
  `${health.status} ${healthJson?.version}`,
);

for (const path of [
  '/',
  '/docs',
  '/faq',
  '/about',
  '/license',
  '/credits',
  '/robots.txt',
  '/sitemap.xml',
  '/og.svg',
  '/favicon.svg',
  '/assets/site.css',
]) {
  const response = await fetch(`${base}${path}`);
  record(`route ${path}`, response.status === 200, String(response.status));
}

const missing = await fetch(`${base}/definitely-not-a-page`);
const missingText = await missing.text();
record(
  '404 page',
  missing.status === 404 && /in the sandbox/i.test(missingText),
  String(missing.status),
);

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
