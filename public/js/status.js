/* The status line — a CLI status bar, not a spinner.

   It answers the questions a spinner refuses to: who is answering, is the
   connection actually up, how long the last reply took, what it cost, and
   how much of today's quota is gone.

   Deliberately not a live region: latency and token counts change constantly
   and would make a screen reader unusable. main.js announces the events that
   matter through its own polite region instead. */

const CONNECTION = {
  online:    { tone: 'ok',   text: 'connected', orb: 'idle' },
  streaming: { tone: 'busy', text: 'streaming', orb: 'busy' },
  offline:   { tone: 'bad',  text: 'offline',   orb: 'offline' },
  error:     { tone: 'bad',  text: 'error',     orb: 'error' },
};

export function createStatus({ root, orb }) {
  const state = {
    connection: 'online',
    model: '—',
    latency: null,
    tokens: null,
    usage: null,
  };

  // drop levels: 1 goes at ≤900px, 2 also goes at ≤560px
  const cells = {
    connection: cell(root, 'link', 0),
    model:      cell(root, 'model', 2),
    latency:    cell(root, 'ttft', 1),
    tokens:     cell(root, 'tok', 1),
    usage:      cell(root, 'today', 2),
  };

  const spacer = document.createElement('span');
  spacer.className = 'status__spacer';
  root.appendChild(spacer);

  const hint = document.createElement('span');
  hint.className = 'status__hint';
  hint.textContent = `${isApple() ? '⌘' : 'Ctrl'}K commands · / slash`;
  root.appendChild(hint);

  function cell(parent, label, drop) {
    const el = document.createElement('span');
    el.className = 'status__cell';
    if (drop) el.dataset.drop = String(drop);
    el.innerHTML = `${label} <b></b>`;
    parent.appendChild(el);
    return el;
  }

  function paint() {
    const link = CONNECTION[state.connection] || CONNECTION.online;
    cells.connection.dataset.tone = link.tone;
    cells.connection.lastElementChild.textContent = link.text;
    if (orb) orb.setState(link.orb);

    cells.model.lastElementChild.textContent = state.model;

    cells.latency.hidden = state.latency == null;
    if (state.latency != null) {
      cells.latency.lastElementChild.textContent =
        state.latency >= 1000 ? `${(state.latency / 1000).toFixed(1)}s` : `${state.latency}ms`;
    }

    cells.tokens.hidden = !state.tokens;
    if (state.tokens) {
      cells.tokens.lastElementChild.textContent =
        `${state.tokens.in}↑ ${state.tokens.out}↓`;
    }

    cells.usage.hidden = !state.usage;
    if (state.usage) {
      cells.usage.lastElementChild.textContent =
        `${state.usage.used}/${state.usage.limit}`;
      cells.usage.dataset.tone =
        state.usage.used >= state.usage.limit ? 'bad' : '';
    }
  }

  paint();

  return {
    set(patch) { Object.assign(state, patch); paint(); },
    get: () => ({ ...state }),
  };
}

const isApple = () =>
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
