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

// Gemini's free tier for gemini-flash-latest, as documented — not pulled live
// from Google (they don't expose a quota-check endpoint), so this is our own
// count of requests we've made today, not an authoritative number from them.
const DAILY_LIMIT = 1500;

async function getUsage(env) {
  const day = new Date().toISOString().slice(0, 10);
  const used = parseInt((await env.USAGE.get(`usage:${day}`)) || "0", 10);
  return { used, limit: DAILY_LIMIT, day };
}

async function incrementUsage(env) {
  const day = new Date().toISOString().slice(0, 10);
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

  const message = typeof body.message === "string" ? body.message.slice(0, 4000) : "";
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

  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents }),
      }
    );
  } catch {
    return json({ error: "Could not reach Gemini." }, 502);
  }

  if (!geminiRes.ok) {
    const detail = await geminiRes.text().catch(() => "");
    return json({ error: "Gemini request failed.", detail, usage }, 502);
  }

  const data = await geminiRes.json();
  const reply =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
    "(no response)";

  return json({ reply, usage });
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
