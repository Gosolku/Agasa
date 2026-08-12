/* Wiring. Everything with a job of its own lives in a module next to this
   one; this file is the part that knows how they fit together. */

import { load, save, newSession, titleFor } from './store.js';
import { streamChat } from './stream.js';
import { renderPart, updatePart } from './render.js';
import { createOrb } from './orb.js';
import { createStatus } from './status.js';
import { createSlash } from './slash.js';
import { createPalette } from './palette.js';
import { createStage, MODULE_IDS } from './stage.js';
import { createDialog } from './dialog.js';
import { createRegistry } from './registry.js';
import { installTelemetry } from './telemetry.js';

const $ = (id) => document.getElementById(id);

const el = {
  rail: $('rail'), railScrim: $('railScrim'), railOpen: $('railOpen'), railClose: $('railClose'),
  sessions: $('sessions'), newSession: $('newSession'), openPalette: $('openPalette'),
  paletteKey: $('paletteKey'), themeToggle: $('themeToggle'),
  thread: $('thread'), threadInner: $('threadInner'), threadTitle: $('threadTitle'),
  composer: $('composer'), input: $('input'), send: $('send'), sendIcon: $('sendIcon'),
  status: $('status'), orb: $('orb'), slash: $('slash'),
  stage: $('stage'), dialog: $('dialog'),
  toast: $('toast'), announce: $('announce'),
};

const THEME_KEY = 'agasa.theme';
const isApple = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');

let sessions = load();
let currentId = sessions[0].id;
let meta = null;
let controller = null;
let streaming = false;
let stickToBottom = true;

const current = () => sessions.find((s) => s.id === currentId) || sessions[0];
const persist = () => save(sessions);

/* ── chrome ────────────────────────────────────────────────────── */

/* First, before anything that could throw: an exception during setup is
   exactly the one worth catching, and a listener installed afterwards would
   miss it. */
const telemetry = installTelemetry({ context: () => clientContext() });

const orb = createOrb(el.orb);
const status = createStatus({ root: el.status, orb });
const dialog = createDialog(el.dialog);

el.paletteKey.textContent = isApple ? '⌘ K' : 'Ctrl K';

/* ── the surface the assistant drives ──────────────────────────── */

/* Everything the tool layer is allowed to touch, gathered in one object.
   Nothing in tools.js or stage.js reaches into this module directly; if a
   capability isn't on this list, no tool can perform it, whatever the model
   asks for and whatever the permission file says. */

const stage = createStage({
  root: el.stage,
  host: {
    toast: (text, tone) => toast(text, tone),
    announce: (text) => announce(text),
    report: (kind, err, extra) => telemetry.report(kind, err, extra),
  },
});

const registry = await createRegistry({
  report: (kind, err, extra) => telemetry.report(kind, err, extra),
  stage,
  dialog: (spec) => dialog.open(spec),
  theme,
  setTheme,
  toast: (text, tone) => toast(text, tone),
  titleOf: (session) => titleFor(session),
  hasSession: (id) => sessions.some((s) => s.id === id),
  selectSession: (id) => selectSession(id),
  consoleWrite: (markdown) => localReply(markdown),
  startSession: (title) => {
    const session = startSession();
    if (title) {
      session.title = String(title).slice(0, 80);
      persist();
      drawRail();
    }
    return session;
  },
  clearSession: () => {
    const removed = current().turns.length;
    current().turns.length = 0;
    persist();
    drawThread();
    drawRail();
    return removed;
  },
});

/* ── theme ─────────────────────────────────────────────────────── */

function theme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function setTheme(next) {
  const value = next === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem(THEME_KEY, value); } catch { /* not important enough to fail on */ }
  const ground = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim();
  const tag = document.querySelector('meta[name="theme-color"]');
  if (tag && ground) tag.setAttribute('content', ground);
  if (orb) orb.retheme();
}

try { setTheme(localStorage.getItem(THEME_KEY) || 'dark'); } catch { setTheme('dark'); }

/* ── slash commands ────────────────────────────────────────────── */

const HELP = `**Commands**

- \`/help\` — this list
- \`/clear\` — empty the current session
- \`/new\` — start a fresh session
- \`/theme [dark|light]\` — switch appearance
- \`/model\` — what is answering right now
- \`/permissions\` — what Agasa is allowed to do
- \`/stage [module]\` — open a module in the view stage, or close it

Agasa can drive all of the above itself — ask it to, rather than typing the
command, and it will use the matching tool.

Press ${isApple ? '⌘K' : 'Ctrl+K'} for the command palette. Shift+Enter for a new line.`;

const COMMANDS = [
  { name: 'help', description: 'Show the command list', aliases: ['?'], run: () => localReply(HELP) },
  {
    name: 'clear',
    description: 'Empty this session',
    run: () => {
      current().turns.length = 0;
      persist();
      drawThread();
      drawRail();
    },
  },
  { name: 'new', description: 'Start a new session', run: () => startSession() },
  {
    name: 'theme',
    args: '[dark|light]',
    description: 'Switch between dark and light',
    run: (arg) => {
      const next = arg === 'dark' || arg === 'light' ? arg : theme() === 'dark' ? 'light' : 'dark';
      setTheme(next);
      toast(`Theme: ${next}`);
    },
  },
  {
    name: 'model',
    description: 'Show the model answering',
    run: () =>
      localReply(
        meta
          ? `Provider **${meta.label}**, model \`${meta.model}\`.\n\nToday: ${meta.usage.used} of ${meta.usage.limit} requests used, resetting at midnight Pacific.`
          : 'Still working out what is on the other end — the status line will fill in once /api/meta answers.'
      ),
  },
  {
    name: 'permissions',
    description: 'What Agasa may do',
    run: () => palette.openView(permissionsView()),
  },
  {
    name: 'stage',
    args: `[${MODULE_IDS.join('|')}|close]`,
    description: 'Open a module in the view stage',
    run: async (arg) => {
      if (!arg || arg === 'close') {
        const result = stage.close();
        toast(result.wasOpen ? 'Stage closed' : 'Stage is already empty');
        return;
      }
      const result = await stage.open(arg, { mode: 'split' });
      if (!result.ok) localReply(result.error);
    },
  },
];

const slash = createSlash({ input: el.input, root: el.slash, commands: COMMANDS });

/* ── command palette ───────────────────────────────────────────── */

const palette = createPalette({
  root: $('palette'),
  getGroups: () => [
    {
      label: 'Session',
      items: [
        { label: 'New session', hint: 'Ctrl N', run: () => startSession() },
        { label: 'Clear this session', run: () => COMMANDS.find((c) => c.name === 'clear').run() },
        { label: 'Delete this session', run: () => removeSession(currentId) },
        { label: 'Copy last reply', run: () => copyLastReply() },
      ],
    },
    {
      label: 'View',
      items: [
        { label: `Switch to ${theme() === 'dark' ? 'light' : 'dark'} theme`, run: () => setTheme(theme() === 'dark' ? 'light' : 'dark') },
        { label: 'Toggle sessions rail', run: () => setRail(el.rail.dataset.open !== 'true') },
      ],
    },
    {
      label: 'Stage',
      items: [
        ...MODULE_IDS.map((id) => ({
          label: `Open ${id}`,
          hint: 'view stage',
          run: () => stage.open(id, { mode: 'split' }),
        })),
        { label: 'Close the stage', run: () => stage.close() },
      ],
    },
    {
      label: 'Assistant',
      items: [
        { label: 'Permissions', run: () => permissionsView() },
        { label: 'Help', run: () => COMMANDS.find((c) => c.name === 'help').run() },
      ],
    },
    {
      label: 'Switch to',
      items: sessions
        .filter((s) => s.id !== currentId)
        .slice(0, 8)
        .map((s) => ({ label: titleFor(s), hint: `${s.turns.length} turns`, run: () => selectSession(s.id) })),
    },
  ],
});

function permissionsView() {
  const view = document.createElement('div');
  view.className = 'perm';

  const note = document.createElement('p');
  note.className = 'perm__note';
  note.textContent = meta && meta.permissions
    ? `Live for ${(meta.permissions.active || []).join(' and ')}. The ` +
      `${(meta.permissions.inert || []).join(', ')} surface is declared but has no ` +
      `executor behind it, so nothing there can run whatever it says. Anything ` +
      `not listed falls back to "${meta.permissions.fallback}".`
    : 'Permission list unavailable — /api/meta did not answer.';
  view.appendChild(note);

  const capabilities = (meta && meta.permissions && meta.permissions.capabilities) || [];
  for (const capability of capabilities) {
    const inert = (meta.permissions.inert || []).includes(capability.surface);

    const row = document.createElement('div');
    row.className = 'perm__row';
    row.dataset.inert = String(inert);

    const id = document.createElement('div');
    id.className = 'perm__id';
    id.textContent = capability.label;
    const detail = document.createElement('small');
    detail.textContent =
      `${capability.id} · ${capability.risk} risk` + (inert ? ' · not wired' : '');
    id.appendChild(detail);

    const decision = document.createElement('span');
    decision.className = 'perm__d';
    // An inert capability reads as denied whatever it is configured as,
    // because that is what decide() actually returns for it.
    decision.dataset.d = inert ? 'deny' : capability.decision;
    decision.textContent = inert ? 'inert' : capability.decision;

    row.append(id, decision);
    view.appendChild(row);
  }

  return view;
}

/* ── sessions ──────────────────────────────────────────────────── */

function drawRail() {
  el.sessions.innerHTML = '';
  for (const session of sessions) {
    const row = document.createElement('div');
    row.setAttribute('role', 'listitem');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session';
    button.setAttribute('aria-current', String(session.id === currentId));

    const title = document.createElement('span');
    title.className = 'session__title';
    title.textContent = titleFor(session);
    button.appendChild(title);
    button.addEventListener('click', () => selectSession(session.id));

    const kill = document.createElement('button');
    kill.type = 'button';
    kill.className = 'session__kill';
    kill.setAttribute('aria-label', `Delete session: ${titleFor(session)}`);
    kill.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    kill.addEventListener('click', (e) => { e.stopPropagation(); removeSession(session.id); });
    button.appendChild(kill);

    row.appendChild(button);
    el.sessions.appendChild(row);
  }
  el.threadTitle.textContent = titleFor(current());
}

function selectSession(id) {
  if (streaming) stopStreaming();
  currentId = id;
  drawRail();
  drawThread();
  setRail(false);
  el.input.focus();
}

function startSession() {
  if (streaming) stopStreaming();
  const session = newSession();
  sessions.unshift(session);
  currentId = session.id;
  persist();
  drawRail();
  drawThread();
  setRail(false);
  el.input.focus();
  return session;
}

function removeSession(id) {
  const index = sessions.findIndex((s) => s.id === id);
  if (index < 0) return;
  if (streaming && id === currentId) stopStreaming();
  sessions.splice(index, 1);
  if (!sessions.length) sessions = [newSession()];
  if (id === currentId) currentId = sessions[0].id;
  persist();
  drawRail();
  drawThread();
}

/* ── thread ────────────────────────────────────────────────────── */

const partsOf = (turn) => turn.parts || [{ type: 'text', text: turn.text }];

function turnElement(turn, { streamingNow = false } = {}) {
  const wrap = document.createElement('article');

  if (turn.role === 'user') {
    wrap.className = 'turn turn--user';
    wrap.textContent = turn.text;
    return wrap;
  }

  wrap.className = `turn turn--agent${turn.error ? ' turn--error' : ''}`;
  wrap.dataset.state = streamingNow ? 'streaming' : 'done';

  const bar = document.createElement('div');
  bar.className = 'turn__meta';
  bar.append(turn.local ? 'console' : 'agasa');

  const actions = document.createElement('div');
  actions.className = 'turn__actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => copyText(turn.text, copy));
  actions.appendChild(copy);
  bar.appendChild(actions);

  wrap.appendChild(bar);
  for (const part of partsOf(turn)) {
    wrap.appendChild(renderPart(part, { caret: streamingNow, onActionDecision: onActionDecision }));
  }
  return wrap;
}

/* ── the action layer ──────────────────────────────────────────── */

/* A call the Worker marked `confirm` is not run until the user says so. The
   prompt is rendered into the thread as an `action` part and the turn stops
   there — the model is parked server-side and cannot proceed until this
   resolves, which is the point: a confirmation the model could route around
   would not be a confirmation. */

const awaitingDecision = new Map(); // call id -> resolve

function onActionDecision({ part, decision }) {
  const resolve = awaitingDecision.get(part.id);
  if (!resolve) {
    // A prompt from a turn that has since been abandoned — the session was
    // switched or cleared out from under it. Nothing to resume.
    toast('That request is no longer live');
    return;
  }
  awaitingDecision.delete(part.id);
  resolve(decision);
}

function askPermission(call, mount) {
  return new Promise((resolve) => {
    awaitingDecision.set(call.id, resolve);
    mount.appendChild(renderPart({ type: 'action', ...call }, { onActionDecision }));
    scrollDown();
  });
}

/**
 * Execute one batch of calls handed over by the Worker and report what each
 * one did. Runs in order rather than in parallel: two calls that both touch
 * the session list would otherwise race, and the model asked for them in an
 * order for a reason.
 */
async function runToolCalls(calls, { mount, turn }) {
  const results = [];

  for (const call of calls) {
    let response;

    if (call.confirm && (await askPermission(call, mount)) !== 'allow') {
      response = { ok: false, error: 'The user denied this action. Do not try it again this turn.' };
    } else {
      status.set({ connection: 'streaming' });
      response = await registry.run(call);
    }

    results.push({ id: call.id, response });

    // A receipt in the thread, so an action the user didn't watch happen is
    // still accounted for afterwards.
    const receipt = { type: 'tool', name: call.name, ok: response.ok !== false, error: response.error };
    turn.parts = [...(turn.parts || []), receipt];
    mount.appendChild(renderPart(receipt));
    scrollDown();
  }

  return results;
}

function drawThread() {
  el.threadInner.innerHTML = '';
  const session = current();

  if (!session.turns.length) {
    el.threadInner.appendChild(blankState());
  } else {
    for (const turn of session.turns) el.threadInner.appendChild(turnElement(turn));
  }
  el.threadTitle.textContent = titleFor(session);
  stickToBottom = true;
  scrollDown('auto');
}

const STARTERS = [
  ['01', 'Explain something I keep half-understanding'],
  ['02', 'Plan my week around revision'],
  ['03', 'Draft the message I keep putting off'],
  ['04', 'Argue against something I believe'],
];

function blankState() {
  const wrap = document.createElement('div');
  wrap.className = 'blank';

  const line = document.createElement('div');
  line.className = 'blank__line';
  const hour = new Date().getHours();
  line.textContent = `${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'} · session ready`;

  const title = document.createElement('h1');
  title.className = 'blank__title';
  title.textContent = 'What are we working on?';

  const grid = document.createElement('div');
  grid.className = 'blank__grid';
  for (const [index, text] of STARTERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'starter';
    const tag = document.createElement('i');
    tag.textContent = index;
    button.append(tag, document.createTextNode(text));
    button.addEventListener('click', () => {
      el.input.value = text;
      resize();
      submit();
    });
    grid.appendChild(button);
  }

  wrap.append(line, title, grid);
  return wrap;
}

function scrollDown(behavior = 'smooth') {
  requestAnimationFrame(() => {
    el.thread.scrollTo({
      top: el.thread.scrollHeight,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : behavior,
    });
  });
}

el.thread.addEventListener('scroll', () => {
  const slack = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight;
  stickToBottom = slack < 64;
}, { passive: true });

/* ── sending ───────────────────────────────────────────────────── */

/* What the assistant is told about the screen it is driving. Deliberately
   small: ids and titles it needs in order to name things back, and the
   current stage, so it doesn't open a module that is already open. Message
   content is not in here — that is what the turn list is for. */
function clientContext() {
  return {
    theme: theme(),
    now: new Date().toLocaleString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }),
    stage: stage.state(),
    sessions: sessions.slice(0, 12).map((s) => ({
      id: s.id,
      title: titleFor(s),
      current: s.id === currentId,
    })),
  };
}

function turnsForModel(session) {
  return session.turns
    .filter((turn) => !turn.local && !turn.error && turn.text.trim())
    .map((turn) => ({ role: turn.role, text: turn.text }));
}

function localReply(text) {
  const session = current();
  const turn = { role: 'assistant', text, local: true };
  session.turns.push(turn);
  if (session.turns.length === 1) el.threadInner.innerHTML = '';
  el.threadInner.appendChild(turnElement(turn));
  persist();
  scrollDown();
}

async function submit() {
  const raw = el.input.value.trim();
  if (!raw || streaming) return;

  const command = slash.resolve(raw);
  if (command) {
    el.input.value = '';
    resize();
    slash.close();
    syncSend();
    command.command.run(command.args);
    return;
  }
  if (raw.startsWith('/')) {
    el.input.value = '';
    resize();
    slash.close();
    syncSend();
    localReply(`Unknown command \`${raw.split(/\s/)[0]}\`. Try \`/help\`.`);
    return;
  }

  const session = current();
  const userTurn = { role: 'user', text: raw };
  session.turns.push(userTurn);
  if (session.turns.length === 1) el.threadInner.innerHTML = '';
  el.threadInner.appendChild(turnElement(userTurn));

  el.input.value = '';
  resize();
  slash.close();

  const payload = turnsForModel(session);

  const agentTurn = { role: 'assistant', text: '' };
  session.turns.push(agentTurn);
  const agentEl = turnElement(agentTurn, { streamingNow: true });
  el.threadInner.appendChild(agentEl);
  const body = agentEl.querySelector('.prose');

  setStreaming(true);
  el.thread.setAttribute('aria-busy', 'true');
  scrollDown();
  drawRail();

  const started = performance.now();
  let firstToken = null;
  let accumulated = '';
  let queued = false;

  const repaint = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      updatePart(body, { type: 'text', text: accumulated }, { caret: true });
      if (stickToBottom) el.thread.scrollTop = el.thread.scrollHeight;
    });
  };

  const finish = (finalText, { error = false } = {}) => {
    agentTurn.text = finalText;
    agentTurn.error = error;
    // Receipts accumulated during the turn become part of it, so a redraw
    // rebuilds what actually happened rather than just what was said.
    const receipts = (agentTurn.parts || []).filter((p) => p.type === 'tool');
    agentTurn.parts = receipts.length
      ? [{ type: 'text', text: finalText }, ...receipts]
      : undefined;
    agentEl.dataset.state = 'done';
    agentEl.classList.toggle('turn--error', error);
    updatePart(body, { type: 'text', text: finalText }, { caret: false });
    setStreaming(false);
    el.thread.setAttribute('aria-busy', 'false');
    persist();
    drawRail();
    if (stickToBottom) scrollDown();
  };

  controller = new AbortController();

  await streamChat({
    messages: payload,
    client: clientContext(),
    signal: controller.signal,
    onToolCall: (calls) => runToolCalls(calls, { mount: agentEl, turn: agentTurn }),
    on: {
      meta: (data) => {
        meta = { ...(meta || {}), ...data };
        status.set({ model: data.model || '—', usage: data.usage, connection: 'streaming' });
      },
      delta: (data) => {
        if (firstToken === null) {
          firstToken = Math.round(performance.now() - started);
          status.set({ latency: firstToken });
        }
        accumulated += data.text || '';
        repaint();
      },
      // The turn is pausing here to let the browser work. Say so, because the
      // caret stops moving and an unexplained stall reads as a hang.
      tool_call: () => {
        updatePart(body, { type: 'text', text: accumulated }, { caret: false });
        status.set({ connection: 'streaming' });
      },
      usage: (data) => status.set({ tokens: data.tokens }),
      done: () => {
        status.set({ connection: 'online' });
        finish(accumulated || '(no reply)');
        announce('Reply complete.');
      },
      error: (data) => {
        status.set({ connection: 'error' });
        const detail = data.detail ? `\n\n\`${String(data.detail).slice(0, 240)}\`` : '';
        finish(`${data.message || 'Something went wrong.'}${detail}`, { error: true });
        announce(`Error: ${data.message || 'request failed'}`);
      },
      aborted: () => {
        status.set({ connection: 'online' });
        finish(accumulated ? `${accumulated}\n\n_Stopped._` : '_Stopped before it started._');
      },
    },
  });

  controller = null;
}

function stopStreaming() {
  if (controller) controller.abort();
}

function setStreaming(on) {
  streaming = on;
  el.send.setAttribute('aria-label', on ? 'Stop generating' : 'Send message');
  el.sendIcon.innerHTML = on
    ? '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>'
    : '<path d="M12 19V5M5 12l7-7 7 7"/>';
  syncSend();
}

function syncSend() {
  const ready = streaming || el.input.value.trim().length > 0;
  el.send.disabled = !ready;
  el.send.dataset.ready = String(ready);
}

function resize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, window.innerHeight * 0.4)}px`;
}

/* ── input ─────────────────────────────────────────────────────── */

el.input.addEventListener('input', () => {
  resize();
  syncSend();
  slash.refresh(el.input.value);
  el.composer.classList.toggle('composer--slash', el.input.value.startsWith('/'));
});

el.input.addEventListener('keydown', (e) => {
  if (slash.handleKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

el.send.addEventListener('click', () => (streaming ? stopStreaming() : submit()));

/* ── copy ──────────────────────────────────────────────────────── */

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const original = button.textContent;
      button.textContent = 'Copied';
      button.dataset.copied = 'true';
      setTimeout(() => {
        button.textContent = original;
        button.dataset.copied = 'false';
      }, 1400);
    } else {
      toast('Copied');
    }
  } catch {
    toast('Clipboard blocked by the browser');
  }
}

// Code-block copy buttons are written by the markdown renderer, so they are
// caught here rather than bound at creation.
el.threadInner.addEventListener('click', (e) => {
  const button = e.target.closest('[data-copy]');
  if (!button) return;
  const code = button.closest('.code').querySelector('pre code');
  copyText(code ? code.textContent : '', button);
});

function copyLastReply() {
  const turns = current().turns;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant' && turns[i].text) return copyText(turns[i].text);
  }
  toast('No reply to copy yet');
}

/* ── rail ──────────────────────────────────────────────────────── */

function setRail(open) {
  el.rail.dataset.open = String(open);
  el.railScrim.dataset.open = String(open);
  el.railScrim.tabIndex = open ? 0 : -1;
  el.railOpen.setAttribute('aria-expanded', String(open));
  if (open) el.rail.querySelector('button').focus();
  else el.railOpen.focus();
}

el.railOpen.addEventListener('click', () => setRail(true));
el.railClose.addEventListener('click', () => setRail(false));
el.railScrim.addEventListener('click', () => setRail(false));
el.newSession.addEventListener('click', () => startSession());
el.openPalette.addEventListener('click', () => palette.open());
el.themeToggle.addEventListener('click', () => setTheme(theme() === 'dark' ? 'light' : 'dark'));

/* ── global keys ───────────────────────────────────────────────── */

addEventListener('keydown', (e) => {
  const meta_ = e.metaKey || e.ctrlKey;
  if (meta_ && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.toggle(); return; }
  if (meta_ && e.key.toLowerCase() === 'n') { e.preventDefault(); startSession(); return; }
  if (e.key === 'Escape') {
    if (palette.isOpen() || dialog.isOpen()) return; // both handle their own
    if (el.rail.dataset.open === 'true') { setRail(false); return; }
    if (streaming) { stopStreaming(); return; }
    if (stage.isOpen()) { stage.close(); return; }
    if (document.activeElement !== el.input) el.input.focus();
  }
});

/* ── connection ────────────────────────────────────────────────── */

addEventListener('online', () => { status.set({ connection: 'online' }); loadMeta(); });
addEventListener('offline', () => status.set({ connection: 'offline' }));

async function loadMeta() {
  if (!navigator.onLine) return status.set({ connection: 'offline' });
  try {
    const res = await fetch('/api/meta');
    if (!res.ok) throw new Error(String(res.status));
    meta = await res.json();
    status.set({
      model: meta.model,
      usage: meta.usage,
      connection: meta.configured ? 'online' : 'error',
    });
    if (!meta.configured) toast(`${meta.label} has no API key on this deployment`);

    // The Worker is about to tell Gemini it can do these things. If this build
    // cannot, that is a broken deployment and it is far better found now than
    // three turns into a conversation.
    const missing = registry.missing();
    if (missing.length) {
      telemetry.report('manifest-drift', new Error(`No handler for: ${missing.join(', ')}`));
      toast(`${missing.length} declared tool${missing.length > 1 ? 's have' : ' has'} no handler`, 'warn');
    }
  } catch (err) {
    status.set({ connection: 'error' });
    telemetry.report('meta', err);
  }
}

/* ── small stuff ───────────────────────────────────────────────── */

let toastTimer = 0;
function toast(text, tone) {
  el.toast.textContent = text;
  el.toast.dataset.tone = tone === 'good' || tone === 'warn' ? tone : '';
  el.toast.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.dataset.show = 'false'), 2600);
}

function announce(text) {
  el.announce.textContent = '';
  // a beat of empty first, or a repeat of the same string is never re-read
  setTimeout(() => (el.announce.textContent = text), 60);
}

/* ── go ────────────────────────────────────────────────────────── */

drawRail();
drawThread();
syncSend();
loadMeta();
if (!matchMedia('(pointer: coarse)').matches) el.input.focus();
