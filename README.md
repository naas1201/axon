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
# {"ok":true,"result":4,"logs":[],"meta":{"wall_ms":0,"modules":[],...}}
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
                                     │  16 MB heap          │
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
| `return 2 + 2` | 2 to 7 ms | 2 to 10 ms | Warm isolate; p50 about 5 ms over 18 calls, p95 about 47 ms. |
| regex over a short string | 1 to 3 ms | 2 to 5 ms | |
| `new Date(...)` | 1 to 3 ms | 2 to 5 ms | |
| `import _ from 'lodash'` (warm) | 38 to 189 ms | 39 to 268 ms | 82 KB bundle parsed by QuickJS; cost depends on isolate warmth. |
| counter loop, 200k iterations | 49 ms | 51 ms | About 0.25 ms per 1000 iterations. |
| `while (true) {}` | 184 to 366 ms | 187 to 375 ms | Cut by the instruction budget, returns a clean 408. |
| 512 MB allocation | 3 to 41 ms | 3 to 42 ms | OOM before the allocation lands. |
| cold isolate, first call | 20 to 47 ms | 21 to 48 ms | wasm instantiation, once per isolate. |

The published free-plan limit is 10 ms of CPU per request. Calls above it were served during these
measurements, but that is not a guarantee and not something to design against. Trivial logic sits at
2 to 5 ms. A whole-library import sits at 90 to 170 ms. If you need the second one on a budget, import
the submodule (`lodash/chunk`) instead of the package.

`meta.wall_ms` in the API response is a different number: Workers freezes `Date.now()` and
`performance.now()` for the duration of a request, so it reads 0 for a pure CPU call. The table above
uses the platform's own per-event timing, which is the honest source.

## Limits

| Limit | Value |
| --- | --- |
| CPU per request | 10 ms (free plan, hard) |
| Request body | 64 KB |
| Code | 32 KB |
| Deadline | 50..1500 ms, default 750 |
| Heap | 4..32 MB, default 16 |
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
- Rate limiting: an atomic per-colo Workers rate-limit binding (30 per 60 s per IP hash) plus a
  10-request burst bucket per isolate. Neither is global: no shared counter exists on the free plan.

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
