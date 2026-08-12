/* Sessions, in localStorage.
   No backend: this is one person's browser, and a KV round-trip per keystroke
   would buy nothing. The shape is deliberately the same one a server would
   return, so moving it later is a swap of these four functions. */

const KEY = 'agasa.sessions.v1';
const MAX_SESSIONS = 60;

const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function newSession() {
  const now = Date.now();
  return { id: uid(), title: '', createdAt: now, updatedAt: now, turns: [] };
}

export function load() {
  let sessions = [];
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) sessions = JSON.parse(raw);
  } catch {
    // Corrupt or unreadable (private mode, quota, hand-edited) — start clean
    // rather than taking the whole app down over saved history.
    sessions = [];
  }
  if (!Array.isArray(sessions) || !sessions.length) return [newSession()];
  return sessions.filter(valid).slice(0, MAX_SESSIONS);
}

export function save(sessions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
  } catch {
    /* full or blocked — the session still works, it just won't survive reload */
  }
}

function valid(s) {
  return s && typeof s.id === 'string' && Array.isArray(s.turns);
}

/** First user turn, trimmed to something that fits the rail. */
export function titleFor(session) {
  if (session.title) return session.title;
  const first = session.turns.find((t) => t.role === 'user');
  if (!first) return 'New session';
  const line = first.text.replace(/\s+/g, ' ').trim();
  return line.length > 46 ? `${line.slice(0, 45)}…` : line;
}
