/* The view stage — the half of the screen that isn't conversation.

   A module is a file in ./modules/ exporting `meta` and `mount(el, ctx)`.
   mount() returns a handle with optional update(params) and destroy(). That
   is the entire contract; a module knows nothing about the stage, the thread,
   the tool layer or Gemini, and the stage knows nothing about what any given
   module does.

   Loading is a dynamic import, so a module's code is only fetched the first
   time something opens it — which is why adding the fifth module costs the
   first paint nothing. The id is looked up in the table below rather than
   interpolated into the path: `import('./modules/' + id + '.js')` would take
   whatever string arrived from a tool call and turn it into a URL, and the
   one thing a tool argument must never become is a code path. */

const LOADERS = {
  timer: () => import('./modules/timer.js'),
  checklist: () => import('./modules/checklist.js'),
};

export const MODULE_IDS = Object.keys(LOADERS);

export function createStage({ root, host }) {
  const body = root.querySelector('.stage__body');
  const title = root.querySelector('.stage__title');
  const closeButton = root.querySelector('.stage__close');
  const modeButton = root.querySelector('.stage__mode');

  let mounted = null;   // { id, handle }
  let mode = 'hidden';
  // Two opens racing (a tool call while a slow import is still in flight)
  // would otherwise both mount, and the loser would leak. Each open takes a
  // ticket and drops its result if a newer one has started since.
  let ticket = 0;

  function apply() {
    root.dataset.mode = mode;
    document.documentElement.dataset.stage = mode;
    root.setAttribute('aria-hidden', String(mode === 'hidden'));
    modeButton.textContent = mode === 'full' ? 'split' : 'full';
    modeButton.setAttribute(
      'aria-label',
      mode === 'full' ? 'Show the conversation alongside' : 'Expand to full width'
    );
  }

  function teardown() {
    if (mounted && mounted.handle && typeof mounted.handle.destroy === 'function') {
      try {
        mounted.handle.destroy();
      } catch {
        /* a module that throws on the way out must not block the next one */
      }
    }
    mounted = null;
    body.innerHTML = '';
  }

  async function open(id, { mode: wanted = 'split', params = {} } = {}) {
    const load = LOADERS[id];
    if (!load) {
      return {
        ok: false,
        error: `There is no module called '${id}'. Available: ${MODULE_IDS.join(', ')}.`,
      };
    }

    // Already up: reconfigure rather than tear down, so a timer doesn't lose
    // its remaining seconds because the model adjusted the label.
    if (mounted && mounted.id === id) {
      mode = wanted === 'full' ? 'full' : 'split';
      apply();
      if (typeof mounted.handle.update === 'function') {
        try {
          mounted.handle.update(params);
        } catch (err) {
          return { ok: false, error: `'${id}' rejected those parameters: ${message(err)}` };
        }
      }
      return { ok: true, module: id, mode, reused: true };
    }

    const mine = ++ticket;
    let module;
    try {
      module = await load();
    } catch (err) {
      if (host.report) host.report('module-load', err, { module: id });
      return { ok: false, error: `Could not load the '${id}' module: ${message(err)}` };
    }
    if (mine !== ticket) return { ok: false, error: 'Superseded by a later open.' };

    teardown();

    const host_ = { ...host, close: () => close() };
    let handle;
    try {
      handle = module.mount(body, { params, host: host_ }) || {};
    } catch (err) {
      // A module that throws in mount() leaves half a DOM behind; clearing it
      // is what stops the next open from inheriting the wreckage.
      body.innerHTML = '';
      if (host.report) host.report('module-mount', err, { module: id, params: Object.keys(params) });
      return { ok: false, error: `'${id}' failed to start: ${message(err)}` };
    }

    mounted = { id, handle };
    title.textContent = (module.meta && module.meta.label) || id;
    mode = wanted === 'full' ? 'full' : 'split';
    apply();

    const focusable = body.querySelector('button, input, [tabindex]');
    if (focusable) focusable.focus();

    return { ok: true, module: id, mode, reused: false };
  }

  function close() {
    if (!mounted && mode === 'hidden') return { ok: true, wasOpen: false };
    const was = mounted && mounted.id;
    ticket += 1; // cancel any import still in flight
    teardown();
    title.textContent = '';
    mode = 'hidden';
    apply();
    return { ok: true, wasOpen: true, module: was || null };
  }

  function setMode(next) {
    if (!mounted) return { ok: false, error: 'Nothing is mounted in the stage.' };
    if (next !== 'split' && next !== 'full') {
      return { ok: false, error: `'${next}' is not a stage mode.` };
    }
    mode = next;
    apply();
    return { ok: true, mode };
  }

  closeButton.addEventListener('click', () => close());
  modeButton.addEventListener('click', () => setMode(mode === 'full' ? 'split' : 'full'));

  apply();

  return {
    open,
    close,
    setMode,
    isOpen: () => Boolean(mounted),
    /** For the context block: what the model can see the user looking at. */
    state: () => ({ module: mounted ? mounted.id : null, mode }),
  };
}

const message = (err) => String((err && err.message) || err).slice(0, 160);
