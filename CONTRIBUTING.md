# Contributing

Small project, short rules.

1. Open an issue before a large change. The scope is deliberately narrow.
2. `npm install`, then `npm test` and `npx tsc --noEmit` must pass.
3. Keep the free plan constraint: no paid bindings (Queues, Durable Objects, R2, KV), no dependency
   that needs a paid CPU limit.
4. No new dependencies for what a few lines can do. The Worker bundle is small on purpose.
5. Style: TypeScript strict, single quotes, semicolons, 100 columns. `npm run format` runs Prettier.
6. Comments explain why, not what. Security-sensitive code (disposal, limits, escaping) needs a
   comment that says what breaks if it is removed.
7. Tests: a change to the lexer or the limiter comes with a unit test. A change to the API comes
   with a line in `scripts/smoke.mjs`.

By contributing you agree that your work is licensed under the MIT license in `LICENSE`.
