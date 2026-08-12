// Client error reports, server side.
//
// Stored in KV under a time-ordered prefix with a short expiry, and read back
// into the system context so the assistant can be asked "why did that fail?"
// and actually answer. That is the whole design goal — this is not an
// analytics pipeline, it is the model's ability to see its own broken limb.
//
// Nothing here is trusted. The payload is written by a page the user can edit,
// so every field is clamped to a length and re-serialised rather than stored
// as it arrived, and src/context.js fences the result as data.

const PREFIX = "error:";
const KEEP = 8;         // how many are shown to the model
const TTL = 60 * 60 * 24 * 3;

const MAX = { kind: 24, message: 300, stack: 1200, extra: 400, ua: 160, url: 120 };

export async function recordError(env, payload) {
  const entry = {
    kind: text(payload && payload.kind, MAX.kind) || "exception",
    message: text(payload && payload.message, MAX.message) || "unknown",
    stack: text(payload && payload.stack, MAX.stack),
    url: text(payload && payload.url, MAX.url),
    ua: text(payload && payload.ua, MAX.ua),
    extra: text(json(payload && payload.extra), MAX.extra),
    at: new Date().toISOString(),
  };

  // The key sorts newest-last by construction, so list() with a limit gives a
  // window without needing to read and compare every value.
  const key = `${PREFIX}${Date.now().toString().padStart(14, "0")}:${crypto.randomUUID().slice(0, 8)}`;
  await env.USAGE.put(key, JSON.stringify(entry), { expirationTtl: TTL });
  return entry;
}

/** The most recent reports, newest first. Never throws — a telemetry read
 *  failing must not be the reason a chat request dies. */
export async function recentErrors(env, limit = KEEP) {
  try {
    const listed = await env.USAGE.list({ prefix: PREFIX, limit: 200 });
    const newest = listed.keys.slice(-limit).reverse();
    const entries = await Promise.all(
      newest.map(async ({ name }) => {
        const raw = await env.USAGE.get(name);
        if (!raw) return null;
        try {
          return JSON.parse(raw);
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

const text = (value, max) =>
  value == null ? "" : String(value).slice(0, max);

function json(value) {
  if (value == null) return "";
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "";
  }
}
