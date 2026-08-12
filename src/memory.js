// Long-term memory.
//
// The conversation in front of the user is short-term memory and lives in the
// browser's localStorage. This file is the other half: what survives closing
// the tab, stored in Cloudflare KV and injected into the system prompt on
// every request, so a detail given on Monday is still known on Friday without
// anyone retyping it.
//
// Two kinds, deliberately separate:
//
//   facts     — small, durable, individually addressable. Preferences,
//               constraints, standing instructions, running counts. Written
//               and deleted by the assistant through remember_fact /
//               forget_fact. Never expire; the only way one leaves is being
//               forgotten on purpose.
//
//   summaries — one per past session, written by the model in its own words
//               when a conversation reaches its end. This is what stops
//               memory costing a fortune: a 60-turn conversation becomes four
//               lines, so the fiftieth session still fits in a prompt.
//
// Everything is bounded. Memory that grows without limit makes every request
// bigger than the last, and on a 1500/day free tier that is the whole budget
// spent on remembering rather than answering.

/**
 * KV lives on `env.MEMORY` if a dedicated namespace is bound, and falls back
 * to the namespace the usage counter already uses. The prefixes below keep
 * them from colliding, so a dedicated namespace is a deployment decision
 * rather than a code change:
 *
 *   npx wrangler kv namespace create agasa-memory
 *   then add the returned id to wrangler.jsonc as binding "MEMORY"
 *
 * Until then this works as-is on the existing binding.
 */
const store = (env) => env.MEMORY || env.USAGE;

const FACT = "fact:";
const SUMMARY = "summary:";

const LIMITS = {
  facts: 120,
  factValue: 600,
  summaries: 60,
  summaryText: 900,
  topics: 6,
  summaryTtl: 60 * 60 * 24 * 90,
};

// Dotted, lower case, at most four segments. Enforced rather than suggested:
// without it the model invents `Chess Rating`, `chess.rating` and
// `chessRating` across three sessions and remembers the same fact three times.
const validKey = (key) => /^[a-z0-9]+(\.[a-z0-9_-]+){0,3}$/.test(String(key));

/* ── facts ─────────────────────────────────────────────────────── */

export async function rememberFact(env, { key, value }) {
  if (!validKey(key)) {
    return {
      ok: false,
      error: `'${key}' is not a valid key — use dotted lower-case, e.g. 'chess.rating' or 'prefs.tone'.`,
    };
  }

  const text = String(value ?? "").slice(0, LIMITS.factValue);
  if (!text.trim()) {
    return { ok: false, error: "Refusing to store an empty value. Use forget_fact to remove one." };
  }

  const kv = store(env);
  const existing = await kv.list({ prefix: FACT, limit: LIMITS.facts + 1 });
  const isNew = !existing.keys.some((k) => k.name === FACT + key);
  if (isNew && existing.keys.length >= LIMITS.facts) {
    return {
      ok: false,
      error: `Memory is full at ${LIMITS.facts} facts. Forget something before recording anything else.`,
    };
  }

  await kv.put(FACT + key, JSON.stringify({ value: text, at: Date.now() }));
  return { ok: true, key, stored: text, replaced: !isNew };
}

export async function forgetFact(env, { key }) {
  if (!validKey(key)) return { ok: false, error: `'${key}' is not a valid key.` };
  const kv = store(env);
  const had = await kv.get(FACT + key);
  await kv.delete(FACT + key);
  // "There was nothing there" is a different answer from "it is gone now",
  // and the model should not report a deletion that never happened.
  return had ? { ok: true, key, deleted: true } : { ok: true, key, deleted: false, note: "No such fact was stored." };
}

export async function allFacts(env) {
  return readAll(env, FACT, LIMITS.facts, (key, parsed) => ({
    key,
    value: parsed.value,
    at: parsed.at,
  }));
}

/* ── summaries ─────────────────────────────────────────────────── */

/**
 * The model writes its own summary rather than a second API call generating
 * one. A summarising request would double the cost of every conversation and
 * add a failure mode where the summary is wrong but nothing notices; the
 * model has just had the conversation and can describe it for free.
 */
export async function saveSummary(env, { session_id, title, summary, topics }) {
  const id = String(session_id || "").slice(0, 60);
  if (!/^[A-Za-z0-9_-]{6,60}$/.test(id)) {
    return {
      ok: false,
      error: "session_id must be one of the ids listed in the interface state.",
    };
  }

  const text = String(summary || "").slice(0, LIMITS.summaryText);
  if (!text.trim()) return { ok: false, error: "A summary needs some text in it." };

  const entry = {
    title: String(title || "Untitled").slice(0, 80),
    summary: text,
    topics: (Array.isArray(topics) ? topics : [])
      .slice(0, LIMITS.topics)
      .map((t) => String(t).slice(0, 30)),
    at: Date.now(),
  };

  await store(env).put(SUMMARY + id, JSON.stringify(entry), {
    expirationTtl: LIMITS.summaryTtl,
  });
  return { ok: true, session_id: id, stored: entry.title };
}

/** Newest first. The caller decides how many it can afford to inject. */
export async function recentSummaries(env, limit = 8) {
  const all = await readAll(env, SUMMARY, LIMITS.summaries, (key, parsed) => ({
    id: key,
    ...parsed,
  }));
  return all.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

/* ── shared ────────────────────────────────────────────────────── */

/**
 * List a prefix and read every value under it. Returns [] rather than
 * throwing on any failure: a memory read that breaks should cost the reply
 * its context, not cost the user their answer.
 */
async function readAll(env, prefix, limit, shape) {
  try {
    const listed = await store(env).list({ prefix, limit });
    const entries = await Promise.all(
      listed.keys.map(async ({ name }) => {
        const raw = await store(env).get(name);
        if (!raw) return null;
        try {
          return shape(name.slice(prefix.length), JSON.parse(raw));
        } catch {
          return null; // one corrupt entry must not poison the whole read
        }
      })
    );
    return entries.filter(Boolean);
  } catch {
    return [];
  }
}
