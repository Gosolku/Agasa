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

    return env.ASSETS.fetch(request);
  },
};

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
    return json({ error: "Gemini request failed.", detail }, 502);
  }

  const data = await geminiRes.json();
  const reply =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
    "(no response)";

  return json({ reply });
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
