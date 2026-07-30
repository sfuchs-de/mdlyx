# Contributing

Issues and focused pull requests are welcome.

1. Use Node.js 22 and run `npm ci`.
2. Create a topic branch.
3. Add tests for behavior changes.
4. Run `npm run check`, `npm run privacy:check`, and the relevant Playwright or
   Rust checks.
5. Keep Markdown files canonical; do not commit generated build output,
   credentials, personal libraries, or private research material.

Please keep changes small enough to review and preserve Markdown round-trip
behavior. A document that does not use a newly supported construct should not be
rewritten merely by opening and saving it.
