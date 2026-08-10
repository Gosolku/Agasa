export default {
  async fetch(request, env) {
    const expected = "Basic " + btoa(`agasa:${env.SITE_PASSWORD}`);
    const provided = request.headers.get("Authorization") || "";

    if (!constantTimeEqual(provided, expected)) {
      return new Response("Authentication required.", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Agasa", charset="UTF-8"' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

function constantTimeEqual(a, b) {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}
