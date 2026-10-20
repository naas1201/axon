# axon

A logic coprocessor for AI agents. POST JavaScript, get JSON back. Code runs in a fresh
QuickJS WebAssembly sandbox with no filesystem, no network and no state between calls.

- Live: <https://axon.va-n.com>
- API: `POST /api/v1/execute`
- License: MIT (code), see [LICENSE](./LICENSE)

```bash
curl -s https://axon.va-n.com/api/v1/execute \
  -H 'content-type: application/json' \
  -d '{"code":"return 2 + 2"}'
# {"ok":true,"result":4,"logs":[],"meta":{"modules":[],"engine":"quickjs 2025-09-13 (bellard)",...}}
```

## Why

Language models are good at deciding what to compute and bad at computing it. axon removes the
guessing: the model sends a few lines of JavaScript, an interpreter runs them, a JSON value comes
back. No account, no key, no storage.

It is deliberately small. One endpoint, one sandbox, one job. The constraint that shapes everything
is the Cloudflare **free plan**, where the published budget is 10 ms of CPU per request. That is
enough for arithmetic, dates, regex, string work and small npm packages. It is not enough for heavy
compute, and the service says so instead of pretending otherwise.

## Architecture

```
                 POST /api/v1/execute
  agent  ────────────────────────────────►  Cloudflare Worker
                                                │
                                                │ 1. per-IP bucket (429)
                                                │ 2. body cap, JSON parse
                                                │ 3. import scanner
                                                │
                                                ▼
                                        esm.sh  ?bundle&target=es2022
                                                │  one file per package
                                                ▼
                                        Map<url, source>  +  cf cache
                                                │
                                                ▼
                                     ┌──────────────────────┐
                                     │  QuickJS (wasm)      │
                                     │  new runtime / call  │
                                     │  8 MB heap           │
                                     │  wall-clock deadline │
                                     │  sync module loader  │
                                     └──────────────────────┘
                                                │
                                                ▼
                                     result + logs + meta
```

Files:

| Path | Role |
| --- | --- |
| `src/index.ts` | Routing, CORS, JSON envelope, rate limit, FIFO admission, body caps. |
| `src/sandbox.ts` | QuickJS runtime, limits, log capture, serialisation, disposal. |
| `src/modules.ts` | esm.sh resolution, import graph, cache, sync loader map. |
| `src/lexer.ts` | Import scanner (comments, strings and property names handled). |
| `src/limits.ts` | Semaphore, token bucket, per-IP limiter. |
| `public/` | The site, served as Workers static assets. |

## The esm.sh trick

The synchronous QuickJS build has a **synchronous** module loader: it cannot `await` a network call
while evaluating. The async build would solve that with ASYNCIFY, at a CPU cost we cannot afford on a
10 ms budget.

So the work is split:

1. Scan the submitted code for import specifiers (static, side effect, dynamic, re-export).
2. Fetch `https://esm.sh/<pkg>?bundle&target=es2022` outside the sandbox. `bundle` flattens the
   dependency graph into one file per package.
3. Follow whatever imports remain, depth 2, at most 10 modules and 1 MB total. Cache in isolate
   memory and in `caches.default` for an hour.
4. Hand QuickJS a `Map<url, source>` and a synchronous loader that reads from it.

Resolution outside, evaluation inside. The sandbox never sees a URL or a socket.

## Deploy in three commands

```bash
npm install
npx wrangler deploy
curl -s https://your-domain/health
```

`wrangler.toml` ships with a `routes` entry for `axon.va-n.com` and `workers_dev = true`. Change or
delete the route for your own domain. There are no paid bindings: no Queues, no Durable Objects, no
R2, no KV.

Requirements: Node 20 or newer, a Cloudflare account, and a zone if you want a custom domain. The
wasm is compiled at build time through a `CompiledWasm` rule, so no runtime download is needed.

## Measured envelope

Measured on 2026-10-19 against the deployed Worker with `wrangler tail --format json`, reading the
`cpuTime` and `wallTime` fields of each event, on the free plan.

| Scenario | cpuTime | wallTime | Notes |
| --- | --- | --- | --- |
| `return 6 * 7` | 3 to 9 ms | 3 to 14 ms | Warm isolate; p50 6 ms CPU / 10 ms wall over 15 calls. |
| `import _ from 'lodash'` (warm) | 44 to 120 ms | 46 to 311 ms | 82 KB bundle parsed by QuickJS; cost depends on isolate warmth. |
| `import _ from 'lodash'` + `return` | 44 to 120 ms | same | Imports are hoisted and the body wrapped, so no `export default` needed. |
| `while (true) {}` | 39 to 282 ms | 39 to 283 ms | Cut by the instruction budget, returns a clean 408. |
| allocation bomb (`new Array(1e6)` in a loop) | 48 to 55 ms | 50 to 56 ms | Trips the 8 MB QuickJS heap, returns a clean 422 MEMORY_LIMIT. |

The published free-plan limit is 10 ms of CPU per request. Calls above it were served during these
measurements, but that is not a guarantee and not something to design against. Trivial logic sits at
3 to 9 ms. A whole-library import sits at 44 to 120 ms. If you need the second one on a budget, import
the submodule (`lodash/chunk`, `date-fns/addDays`) instead of the package root: a root barrel can
expand to hundreds of modules and is refused once the graph passes 10.

The API deliberately reports no server-side duration: Workers freezes `Date.now()` and
`performance.now()` while a request executes, so such a field would always read 0. The table above uses
the platform's own per-event timing (`wrangler tail --format json`), which is the honest source.

## Limits

| Limit | Value |
| --- | --- |
| CPU per request | 10 ms advertised (free plan), burst tolerated in practice |
| Request body | 64 KB |
| Code | 32 KB |
| Deadline | 50..1500 ms, default 750 |
| Heap | 4..32 MB, default 8 |
| Module graph | 10 modules, 1 MB, depth 2 |
| Concurrency | 4 per isolate, 64 queued, 2 s wait |
| Rate | 30 requests / 60 s, burst 10, per IP per colo |
| Daily requests | 100,000 (platform) |

## Security model

- QuickJS compiled to WebAssembly, one runtime and one heap per request. No shared context.
- No `fetch`, no `XMLHttpRequest`, no sockets, no filesystem, no `process`, no `require`, no env.
- Node builtins are refused before any fetch.
- Memory ceiling enforced by the runtime, wall-clock deadline enforced by an interrupt handler.
- Log capture is a bounded ring buffer (50 lines, 2 KB per line).
- Results are serialised inside the VM, capped at 256 KB.
- API responses: `no-store`, `x-request-id`, `nosniff`, `no-referrer`, `DENY` framing.
- Request bodies are not logged and not stored. There is no database in the deployment.
- Rate limiting: a per-location Workers rate-limit binding (30 per 60 s per IP hash) plus a
  10-request burst bucket per isolate. Both are best effort: with no global counter on the free
  plan, a client spread across isolates can exceed the limit (measured, see FAQ).

Report a vulnerability to <qmpro@outlook.com>, see [SECURITY.md](./SECURITY.md).

## Tests

```bash
npm test                             # unit tests (lexer, semaphore, limiter)
npx tsc --noEmit                     # strict type check
node scripts/smoke.mjs               # live scenarios against production
node scripts/smoke.mjs http://127.0.0.1:8788
```

The smoke script prints a pass/fail table and exits non-zero on failure. It covers math, strings,
regex, dates, a real lodash import, timeouts, OOM, bad packages, Node builtins, malformed bodies, a
25-request burst, health and every page.

## Project layout

```
src/            Worker and sandbox
test/           Vitest unit tests
scripts/        smoke.mjs and small maintenance scripts
public/         HTML, CSS, SVG, robots.txt, sitemap.xml
wrangler.toml   Worker config, assets, wasm rule, observability
```

## License

MIT, copyright 2026 LPP Development Studio / Quentin Mouilhaud. See [LICENSE](./LICENSE).
