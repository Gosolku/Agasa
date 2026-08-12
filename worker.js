export default {
  async fetch(request, env) {
    const expected = "Basic " + btoa(`agasa:${env.SITE_PASSWORD}`);
    const provided = request.headers.get("Authorization") || "";
    const authorized = constantTimeEqual(provided, expected);

    if (!authorized) {
      // Only failed attempts consume the rate limit — legit repeat visits
      // (browser resending valid credentials on every asset) are unaffected.
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.LOGIN_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response("Too many attempts. Try again in a minute.", {
          status: 429,
        });
      }

      return new Response("Authentication required.", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Agasa", charset="UTF-8"' },
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }
    if (url.pathname === "/api/usage" && request.method === "GET") {
      return json(await getUsage(env));
    }

    return env.ASSETS.fetch(request);
  },
};

const MODEL = "gemini-flash-latest";

const SYSTEM_PROMPT =
  "You are Agasa, a personal assistant. Be direct and concise — no filler, " +
  "no restating the question, no unearned praise. Answer plainly in British " +
  "English. Use short paragraphs; only use lists when the content is genuinely " +
  "a list. If you do not know something, say so.";

// Gemini's free tier for gemini-flash-latest, as documented — not pulled live
// from Google (they don't expose a quota-check endpoint), so this is our own
// count of requests we've made today, not an authoritative number from them.
// Only counts requests that go through this Worker with this key.
const DAILY_LIMIT = 1500;

// Google resets the real free-tier quota at midnight Pacific time, so the
// counter has to key off the Pacific date, not UTC, to stay in sync.
function pacificDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function getUsage(env) {
  const day = pacificDateString();
  const used = parseInt((await env.USAGE.get(`usage:${day}`)) || "0", 10);
  return { used, limit: DAILY_LIMIT, day };
}

async function incrementUsage(env) {
  const day = pacificDateString();
  const key = `usage:${day}`;
  const used = parseInt((await env.USAGE.get(key)) || "0", 10) + 1;
  // expire after 2 days — no cleanup needed, and tomorrow's key starts fresh
  await env.USAGE.put(key, String(used), { expirationTtl: 172800 });
  return { used, limit: DAILY_LIMIT, day };
}

async function handleChat(request, env) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: "GEMINI_API_KEY not configured." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  const message =
    typeof body.message === "string" ? body.message.slice(0, 4000) : "";
  if (!message.trim()) {
    return json({ error: "Empty message." }, 400);
  }

  // Keep only the last few turns — this is a test chat, not a full memory system.
  const history = Array.isArray(body.history) ? body.history.slice(-20) : [];

  const contents = [
    ...history.map((m) => ({
      role: m && m.role === "assistant" ? "model" : "user",
      parts: [{ text: String((m && m.text) || "").slice(0, 4000) }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  const usage = await incrementUsage(env);

  // Stream token-by-token so the page can render the reply as it arrives
  // rather than sitting on a spinner until the whole answer is ready.
  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        }),
      }
    );
  } catch {
    return json({ error: "Could not reach Gemini." }, 502);
  }

  if (!geminiRes.ok || !geminiRes.body) {
    const detail = await geminiRes.text().catch(() => "");
    return json({ error: "Gemini request failed.", detail, usage }, 502);
  }

  // Pass Google's SSE frames straight through; the client already knows how to
  // pull text out of a Gemini chunk, so there's nothing to re-encode here.
  return new Response(geminiRes.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-usage-used": String(usage.used),
      "x-usage-limit": String(usage.limit),
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function constantTimeEqual(a, b) {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}
