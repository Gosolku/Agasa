/* The tool layer, browser side.

   The manifest says which tools exist and which handler each one uses; this
   file says what those handlers do. Splitting it that way means adding a tool
   is a manifest entry plus a function here, and the model finds out about it
   without a line of Worker code changing.

   Handlers return a plain object that goes to the model verbatim as the
   function response. Two rules for what goes in one:

     - Report failure honestly. A handler that swallows its own error leaves
       the model telling the user something happened when it didn't.
     - Return what the model could not otherwise know. dialogOpen returning
       the button pressed is the entire point of it. */

const MANIFEST_URL = '/js/manifest.json';

export async function createRegistry(host) {
  const handlers = buildHandlers(host);

  let manifest;
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    // Without the manifest the browser still has its handlers, so tool calls
    // relayed by the Worker keep working; only the local module list and the
    // consistency check are lost. Degrade, don't break.
    manifest = { tools: [], modules: [] };
    if (host.report) host.report('manifest', err, { url: MANIFEST_URL });
  }

  const declared = new Map((manifest.tools || []).map((t) => [t.name, t]));

  return {
    version: manifest.version,
    modules: () => manifest.modules || [],

    /**
     * Tools the Worker will offer the model that this build cannot perform.
     * Empty is the only healthy answer; anything else is a deployment where
     * the manifest and the code have drifted apart, and it is much better to
     * find that out on load than mid-turn.
     */
    missing() {
      return (manifest.tools || [])
        .filter((t) => t.side === 'client' && !handlers[t.handler])
        .map((t) => t.name);
    },

    /**
     * Run one call. Never throws: a thrown handler would abort the whole
     * batch and strand the parked turn on the server with nothing to resume it.
     */
    async run(call) {
      const tool = declared.get(call.name);
      const handler = tool && handlers[tool.handler];

      if (!handler) {
        return { ok: false, error: `The interface has no handler for '${call.name}'.` };
      }
      try {
        return (await handler(call.args || {})) || { ok: true };
      } catch (err) {
        if (host.report) host.report('tool', err, { tool: call.name });
        return { ok: false, error: String((err && err.message) || err).slice(0, 200) };
      }
    },
  };
}

function buildHandlers(host) {
  return {
    themeSet({ mode }) {
      const next = mode === 'toggle' ? (host.theme() === 'dark' ? 'light' : 'dark') : mode;
      if (next !== 'dark' && next !== 'light') return { ok: false, error: `'${mode}' is not a theme.` };
      host.setTheme(next);
      return { ok: true, theme: next };
    },

    sessionNew({ title }) {
      const session = host.startSession(title);
      return { ok: true, id: session.id, title: host.titleOf(session) };
    },

    sessionSwitch({ id }) {
      if (!host.hasSession(id)) {
        return { ok: false, error: `No session with id '${id}'. The open sessions are listed in the interface state.` };
      }
      host.selectSession(id);
      return { ok: true, id };
    },

    sessionClear() {
      return { ok: true, turnsRemoved: host.clearSession() };
    },

    // The stage returns its own {ok, ...} shapes, failures included, so they
    // pass straight through rather than being re-wrapped.
    stageOpen({ module, mode, params }) {
      return host.stage.open(String(module), {
        mode: mode === 'full' ? 'full' : 'split',
        params: params && typeof params === 'object' ? params : {},
      });
    },

    stageClose() {
      return host.stage.close();
    },

    notify({ text, tone }) {
      host.toast(String(text).slice(0, 140), tone);
      return { ok: true, shown: true };
    },

    consoleWrite({ markdown }) {
      host.consoleWrite(String(markdown));
      return { ok: true, written: true };
    },

    async dialogOpen({ title, body, choices }) {
      const labels = Array.isArray(choices) && choices.length
        ? choices.slice(0, 3).map((c) => String(c).slice(0, 40))
        : ['Close'];
      const chosen = await host.dialog({ title: String(title), body: String(body), choices: labels });
      // Escape is an answer, and a different one from pressing the first
      // button — the model has to be able to tell them apart.
      return chosen === null
        ? { ok: true, dismissed: true, chose: null }
        : { ok: true, dismissed: false, chose: chosen };
    },
  };
}
