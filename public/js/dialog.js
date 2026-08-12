/* Modal dialog — the only thing on the page that takes an answer and waits.

   Returns a promise resolving to the chosen label, or null if the user backed
   out with Escape or the scrim. Null is a real answer and is reported to the
   model as one: "they closed it" and "they pressed Cancel" are different
   facts, and collapsing them would have the model act on a decision nobody
   made. */

import { markdown } from './markdown.js';

export function createDialog(root) {
  const panel = root.querySelector('.dialog__panel');
  const titleEl = root.querySelector('.dialog__title');
  const bodyEl = root.querySelector('.dialog__body');
  const footEl = root.querySelector('.dialog__foot');

  let settle = null;
  let restoreFocus = null;

  function finish(value) {
    if (!settle) return;
    const done = settle;
    settle = null;
    root.dataset.open = 'false';
    footEl.innerHTML = '';
    if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
    restoreFocus = null;
    done(value);
  }

  function open({ title, body, choices }) {
    // A second dialog while one is up would orphan the first promise. The
    // older one resolves as dismissed so its caller is never left hanging.
    finish(null);

    return new Promise((resolve) => {
      settle = resolve;
      restoreFocus = document.activeElement;

      titleEl.textContent = title;
      bodyEl.innerHTML = markdown(body);

      footEl.innerHTML = '';
      choices.forEach((label, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = index === 0 ? 'btn btn--primary' : 'btn';
        button.textContent = label;
        button.addEventListener('click', () => finish(label));
        footEl.appendChild(button);
      });

      root.dataset.open = 'true';
      const first = footEl.querySelector('button');
      if (first) first.focus();
    });
  }

  root.addEventListener('keydown', (e) => {
    if (!settle) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't let main.js's Escape handler also fire
      finish(null);
      return;
    }
    if (e.key === 'Tab') {
      const focusable = panel.querySelectorAll('button');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  root.addEventListener('mousedown', (e) => {
    if (e.target === root) finish(null);
  });

  return { open, isOpen: () => Boolean(settle) };
}
