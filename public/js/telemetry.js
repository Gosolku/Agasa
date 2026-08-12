/* Error telemetry.

   The point is not a dashboard. It is that when a module fails to mount or a
   handler throws, the assistant driving this interface can be told about it
   and say so, instead of the user watching nothing happen and having to
   describe the silence. Reports go to /api/telemetry, the Worker keeps the
   last few, and they are injected into the system context — so "why didn't
   that open?" has an answer in the same conversation.

   Everything here is bounded on purpose. An error inside a render loop can
   fire hundreds of times a second, and an unbounded reporter turns a visual
   bug into an outage. */

const ENDPOINT = '/api/telemetry';
const MAX_PER_SESSION = 20;
const MIN_GAP_MS = 2000;

export function installTelemetry({ context } = {}) {
  let sent = 0;
  let lastAt = 0;
  const seen = new Set(); // fingerprints, so a repeating error reports once

  function report(kind, error, extra = {}) {
    const message = String((error && error.message) || error || 'unknown').slice(0, 300);
    const stack = String((error && error.stack) || '').slice(0, 1200);
    const fingerprint = `${kind}:${message}:${stack.slice(0, 120)}`;

    if (seen.has(fingerprint)) return;
    if (sent >= MAX_PER_SESSION) return;
    const now = Date.now();
    if (now - lastAt < MIN_GAP_MS) return;

    seen.add(fingerprint);
    sent += 1;
    lastAt = now;

    const payload = JSON.stringify({
      kind,
      message,
      stack,
      extra,
      at: new Date().toISOString(),
      url: location.pathname,
      ua: navigator.userAgent.slice(0, 160),
      context: typeof context === 'function' ? safeContext(context) : undefined,
    });

    // keepalive so a report fired during unload still leaves. sendBeacon
    // would be tidier but cannot carry the Basic Auth the Worker requires on
    // every route, so it would 401 and be dropped silently.
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* reporting an error must never itself throw */
    }
  }

  addEventListener('error', (e) => {
    // Failed <script>/<img> loads surface here too, with no error object.
    if (!e.error && e.target && e.target !== window) {
      report('resource', new Error(`Failed to load ${e.target.src || e.target.href || 'a resource'}`));
      return;
    }
    report('exception', e.error || e.message, { line: e.lineno, col: e.colno, file: e.filename });
  }, true);

  addEventListener('unhandledrejection', (e) => {
    report('rejection', e.reason);
  });

  return { report };
}

function safeContext(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
