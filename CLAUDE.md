# Agasa

A personal assistant that runs the interface it speaks through. Cloudflare
Worker fronting static assets, Gemini behind a provider abstraction, HTTP Basic
auth over the whole origin.

## Atomic commit rule

**Every individual improvement gets its own commit, and no commit happens
until both gates pass.**

```bash
# gate 1 — every module parses
for f in public/js/*.js public/js/modules/*.js src/*.js src/tools/*.js \
         src/providers/*.js worker.js; do
  node --input-type=module --check < "$f" || echo "FAIL $f"
done

# gate 2 — the Worker actually builds
npx wrangler deploy --dry-run
```

One task, one commit. Not one commit per session, and not one commit per file.
If a change spans the Worker, the manifest and the front end, that is still one
improvement and one commit — but a second, unrelated improvement waits for its
own. Commit messages say why, not what; the diff already says what.

Nothing is pushed unless asked.

## Architecture

- `worker.js` — auth, routing, the tool loop, usage counting. Every request
  passes through it, including asset fetches (`run_worker_first: true`).
- `src/providers/` — the only files that know a vendor's wire format. Adding a
  provider is a file plus a registry entry; no route, protocol or front-end
  change.
- `src/protocol.js` — our own SSE vocabulary: `meta / delta / tool_call /
  action / usage / done / error`. The browser never sees Google's shapes.
- `public/js/manifest.json` — single source of truth for the tool layer.
  Imported by the Worker at build time, fetched by the browser at runtime. A
  tool cannot be declared to the model without a handler shipping alongside it;
  `registry.missing()` fails loudly on boot if they drift.
- `src/permissions.config.js` — `decide()` is called before every dispatch,
  including the obviously-allowed ones. There is deliberately no fast path.
  Device capabilities are hard-denied in code regardless of configuration.
- `src/memory.js` — long-term memory. `fact:` keys are permanent, `summary:`
  keys last 90 days. Injected into the system prompt by `systemWithContext()`
  in the Worker, never by a provider.

## Rules that have bitten before

- **Truncation must not touch file parts.** `normaliseTurns` caps text at 4000
  chars; running that over base64 produces a corrupt attachment and an
  unhelpful Gemini error.
- **Client-supplied context is data, not instruction.** Session titles and
  filenames go inside `<interface-state>` fences in `src/context.js` and are
  stripped of `<>` and newlines first.
- **Tool names are whitelisted, never interpolated.** Module ids likewise —
  `import('./modules/' + id + '.js')` would turn a tool argument into a code
  path.
- **Free tier is 1500 requests/day**, counted in KV against a Pacific-midnight
  reset. Every tool hop is a request. Context that grows without limit spends
  the budget on remembering rather than answering.
