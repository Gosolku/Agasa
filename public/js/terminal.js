/* The whole interface: a log of lines and a prompt.

   Deliberately thin. It holds the turn list in memory, hands it to
   streamChat, and appends characters as they arrive. No sessions, no
   markdown, no tool dispatch — those live in the modules this page does not
   load yet, and each one can come back when it earns its place. */

import { streamChat } from '/js/stream.js';

export function createTerminal(root, names = {}) {
  const log = root.querySelector('[data-log]');
  const form = root.querySelector('form');
  const input = root.querySelector('input[type="text"]');
  const meter = root.querySelector('[data-meter]');

  const speaker = {
    user: names.user || 'You',
    agent: names.agent || 'Agasa',
    error: 'Broken',
  };

  /** @type {Array<{role:string, text:string}>} */
  const turns = [];
  let busy = false;

  function line(kind, text = '') {
    const el = document.createElement('p');
    el.className = 'line';
    el.dataset.kind = kind;

    if (speaker[kind]) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = speaker[kind];
      el.appendChild(who);
    }

    el.appendChild(document.createTextNode(text));
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function send(text) {
    if (busy || !text.trim()) return;
    busy = true;
    input.value = '';
    root.dataset.busy = 'true';

    line('user', text);
    turns.push({ role: 'user', text });

    const out = line('agent');
    let answer = '';
    // The caret is a separate node so streamed text can land in front of it
    // without the browser reflowing a character it is about to replace.
    const caret = document.createElement('span');
    caret.className = 'caret';
    out.appendChild(caret);

    const write = (chunk) => {
      answer += chunk;
      caret.before(document.createTextNode(chunk));
      log.scrollTop = log.scrollHeight;
    };

    const finish = () => {
      caret.remove();
      if (answer.trim()) turns.push({ role: 'assistant', text: answer });
      else out.remove();
      busy = false;
      root.dataset.busy = 'false';
      input.focus();
    };

    streamChat({
      messages: turns,
      on: {
        meta(data) {
          if (!data || !data.usage) return;
          const { used, limit } = data.usage;
          if (typeof used === 'number' && typeof limit === 'number') {
            meter.textContent = `${Math.max(0, limit - used)} left today`;
          }
        },
        delta(data) {
          if (data && typeof data.text === 'string') write(data.text);
        },
        tool_call() {
          // Nothing on this page can carry out a tool call yet, so say so
          // rather than let the turn die of a timeout.
          write('\n[this terminal cannot run tools yet]');
        },
        error(data) {
          caret.remove();
          line('error', (data && data.message) || 'Something went wrong.');
          finish();
        },
        aborted: finish,
        done: finish,
      },
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send(input.value);
  });

  return { send, focus: () => input.focus() };
}
