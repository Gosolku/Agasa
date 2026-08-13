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
  change. Two live: `gemini.js` and `cf-ai.js` (Cloudflare Workers AI).
  Selection is `env.PROVIDER` first, then the AI binding if it is present,
  then Gemini — so pinning the better model on a deployment that has both is a
  dashboard variable, not a deploy.
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
- **Gemini's free tier is 20 requests/day and 5/minute**, confirmed against AI
  Studio for Gemini 3.6 Flash (what `gemini-flash-latest` resolves to). Counted
  in KV against a Pacific-midnight reset. Every tool hop is a separate request,
  so a message that triggers a tool costs at least two and the usable budget is
  nearer seven messages a day. Treat a saved request as the scarce resource,
  not tokens.
- **Workers AI is billed in Neurons, not requests.** The free allocation is
  10,000 Neurons a day — a compute unit, not a request count. At the published
  rates for `@cf/meta/llama-3.3-70b-instruct-fp8-fast` that is roughly 85
  Agasa-shaped requests, which is the number `cfAi.dailyLimit` declares.
  Anything that reads "10,000 requests/day" is a misreading of the pricing
  page. There is also a 300 requests/minute cap, which the counter ignores.
- **Not every Workers AI model can call a tool.** No Llama 3.1 model appears in
  Cloudflare's function-calling catalogue, `-fast` variants included, and a
  model that cannot call a tool cannot run this assistant. Check the catalogue
  before changing `MODEL` in `src/providers/cf-ai.js`.
