/* Long-term memory.

   The implementations behind progress_write / progress_delete, which are
   declared in public/js/manifest.json like everything else. These run inside
   the Worker against KV — no browser round trip, so a call and its result
   happen within one Gemini turn rather than costing the user a visible pause.

   This is the half that makes the assistant a core rather than a chat window.
   Everything written here is injected into the system instruction on every
   subsequent request (see src/context.js), so a fact recorded on Monday is
   present on Friday without anyone re-typing it.

   One KV key per fact rather than one blob, so a write is a write and not a
   read-modify-write race against another tab. The shared prefix means the
   whole set can be listed cheaply for injection into the system prompt. */

const PREFIX = "progress:";
const MAX_KEYS = 120;
const MAX_VALUE = 600;

const validKey = (key) => /^[a-z0-9]+(\.[a-z0-9_-]+){0,3}$/.test(String(key));

export async function progressWrite(env, { key, value }) {
  if (!validKey(key)) {
    return { ok: false, error: `'${key}' is not a valid key — use dotted lower-case, e.g. 'chess.rating'.` };
  }
  const text = String(value ?? "").slice(0, MAX_VALUE);
  if (!text.trim()) return { ok: false, error: "Refusing to store an empty value; use progress_delete instead." };

  const existing = await env.USAGE.list({ prefix: PREFIX, limit: MAX_KEYS + 1 });
  const isNew = !existing.keys.some((k) => k.name === PREFIX + key);
  if (isNew && existing.keys.length >= MAX_KEYS) {
    return { ok: false, error: `Memory is full at ${MAX_KEYS} facts. Delete something first.` };
  }

  await env.USAGE.put(PREFIX + key, JSON.stringify({ value: text, at: Date.now() }));
  return { ok: true, key, stored: text };
}

export async function progressDelete(env, { key }) {
  if (!validKey(key)) return { ok: false, error: `'${key}' is not a valid key.` };
  await env.USAGE.delete(PREFIX + key);
  return { ok: true, key, deleted: true };
}

/** Every stored fact, for injection. Returns [] rather than throwing if KV
 *  is unreachable — a missing memory should degrade the reply, not kill it. */
export async function progressAll(env) {
  try {
    const listed = await env.USAGE.list({ prefix: PREFIX, limit: MAX_KEYS });
    const entries = await Promise.all(
      listed.keys.map(async ({ name }) => {
        const raw = await env.USAGE.get(name);
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          return { key: name.slice(PREFIX.length), value: parsed.value, at: parsed.at };
        } catch {
          return null;
        }
      })
    );
    return entries.filter(Boolean);
  } catch {
    return [];
  }
}
