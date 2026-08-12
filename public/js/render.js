/* The seam between "a response exists" and "a response is on screen".

   A turn is a list of parts. Each part has a `type`, and each type has a
   renderer registered here. Nothing in the streaming code, the store or the
   composer knows how any part is drawn — they only ever hand parts to
   renderPart().

   Three types are produced: `text` for prose, `tool` for the record of a
   call that ran, and `action` for one that needs permission first. An
   `action` part's Allow/Deny is reported to ctx.onActionDecision — this file
   renders the prompt and has no opinion about what a decision means. */

import { markdown } from './markdown.js';

/** @type {Map<string, {create:Function, update?:Function}>} */
const renderers = new Map();

export function registerPartRenderer(type, renderer) {
  renderers.set(type, renderer);
}

export function renderPart(part, ctx = {}) {
  const renderer = renderers.get(part.type) || renderers.get('text');
  return renderer.create(part, ctx);
}

/** Re-render an existing element in place — used on every streamed chunk. */
export function updatePart(el, part, ctx = {}) {
  const renderer = renderers.get(part.type) || renderers.get('text');
  if (renderer.update) renderer.update(el, part, ctx);
}

/* ── text ──────────────────────────────────────────────────────── */

registerPartRenderer('text', {
  create(part, ctx) {
    const el = document.createElement('div');
    el.className = 'prose';
    paint(el, part, ctx);
    return el;
  },
  update: (el, part, ctx) => paint(el, part, ctx),
});

function paint(el, part, ctx) {
  el.innerHTML = markdown(part.text);
  if (ctx.caret) attachCaret(el);
}

// The caret belongs *inside* the last block so it sits at the end of the
// sentence being written, rather than orphaned on a line of its own.
function attachCaret(el) {
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.setAttribute('aria-hidden', 'true');
  const last = el.lastElementChild;
  if (last && /^(P|LI|H1|H2|H3|BLOCKQUOTE)$/.test(last.tagName)) last.appendChild(caret);
  else el.appendChild(caret);
}

/* ── tool receipt ──────────────────────────────────────────────── */

/* What a tool call did, after the fact. One line, mono, deliberately quiet:
   the user watched the theme change or the module appear, so this is a record
   rather than an announcement. Failures are the exception and say why. */

registerPartRenderer('tool', {
  create(part) {
    const el = document.createElement('div');
    el.className = 'receipt';
    el.dataset.ok = String(part.ok !== false);

    const name = document.createElement('b');
    name.textContent = part.name;
    el.append(part.ok === false ? '✕ ' : '✓ ', name);

    if (part.ok === false && part.error) {
      const why = document.createElement('span');
      why.textContent = ` — ${part.error}`;
      el.appendChild(why);
    }
    return el;
  },
});

/* ── action ────────────────────────────────────────────────────── */

registerPartRenderer('action', {
  create(part, ctx) {
    const el = document.createElement('div');
    el.className = 'action';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', `Requested action: ${part.label || part.capability}`);

    const risk = part.risk ? `<span class="action__risk">${esc(part.risk)}</span>` : '';
    el.innerHTML =
      `<div class="action__head">Permission required${risk}</div>` +
      `<div class="action__body"><b>${esc(part.label || part.capability || 'Unknown action')}</b>` +
      (part.detail ? `<div>${esc(part.detail)}</div>` : '') +
      `</div>` +
      `<div class="action__foot">` +
      `<button type="button" class="btn" data-decide="allow">Allow once</button>` +
      `<button type="button" class="btn" data-decide="deny">Deny</button>` +
      `</div>`;

    el.addEventListener('click', (e) => {
      const button = e.target.closest('[data-decide]');
      if (!button) return;
      const decision = button.dataset.decide;
      el.querySelectorAll('[data-decide]').forEach((b) => (b.disabled = true));
      // The host decides what a decision *means*. There is no host yet.
      if (typeof ctx.onActionDecision === 'function') {
        ctx.onActionDecision({ part, decision });
      }
    });

    return el;
  },
});

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
