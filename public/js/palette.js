/* Command palette — Cmd/Ctrl+K.

   Actions are supplied by main.js as groups, rebuilt every time the palette
   opens so session entries are current. An action may return an element from
   run(); if it does, the palette shows that element as a sub-view instead of
   closing, which is how the permissions list is displayed without needing a
   route or a modal of its own. */

export function createPalette({ root, getGroups }) {
  const field = root.querySelector('input');
  const list = root.querySelector('.palette__list');
  const panel = root.querySelector('.palette__panel');

  let flat = [];
  let index = 0;
  let restoreFocus = null;
  let view = null;

  const isOpen = () => root.dataset.open === 'true';

  function build(query) {
    const q = query.trim().toLowerCase();
    list.innerHTML = '';
    flat = [];

    for (const group of getGroups()) {
      const items = group.items.filter(
        (item) => !q || item.label.toLowerCase().includes(q) ||
                  (item.hint || '').toLowerCase().includes(q)
      );
      if (!items.length) continue;

      const heading = document.createElement('div');
      heading.className = 'palette__group';
      heading.textContent = group.label;
      list.appendChild(heading);

      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'palette__item';
        button.setAttribute('role', 'option');
        const label = document.createElement('span');
        label.textContent = item.label;
        button.appendChild(label);
        if (item.hint) {
          const hint = document.createElement('em');
          hint.textContent = item.hint;
          button.appendChild(hint);
        }
        button.addEventListener('click', () => run(item));
        flat.push({ item, button });
        list.appendChild(button);
      }
    }

    if (!flat.length) {
      const empty = document.createElement('div');
      empty.className = 'palette__empty';
      empty.textContent = 'Nothing matches that.';
      list.appendChild(empty);
    }

    index = 0;
    mark();
  }

  function mark() {
    flat.forEach(({ button }, i) => {
      const selected = i === index;
      button.setAttribute('aria-selected', String(selected));
      if (selected) button.scrollIntoView({ block: 'nearest' });
    });
  }

  function run(item) {
    const result = item.run();
    if (result instanceof HTMLElement) showView(result);
    else close();
  }

  function showView(el) {
    view = el;
    field.parentElement.hidden = true;
    list.hidden = true;
    panel.appendChild(el);
    // The view replaces the search field, so focus has to follow it or it
    // would be left on a hidden input.
    el.tabIndex = -1;
    el.focus();
  }

  function clearView() {
    if (!view) return;
    view.remove();
    view = null;
    field.parentElement.hidden = false;
    list.hidden = false;
    field.focus();
  }

  function open() {
    if (isOpen()) return;
    restoreFocus = document.activeElement;
    root.dataset.open = 'true';
    field.value = '';
    build('');
    field.focus();
  }

  function close() {
    if (!isOpen()) return;
    clearView();
    root.dataset.open = 'false';
    if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
    restoreFocus = null;
  }

  field.addEventListener('input', () => build(field.value));

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Esc backs out of a sub-view first, and only then shuts the palette.
      if (view) clearView(); else close();
      return;
    }
    if (view) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); index = (index + 1) % flat.length; mark(); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); index = (index - 1 + flat.length) % flat.length; mark(); }
    if (e.key === 'Enter' && flat[index]) { e.preventDefault(); run(flat[index].item); }
    if (e.key === 'Tab') {
      // Keep focus inside the panel while it is open.
      const focusable = panel.querySelectorAll('input, button');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // Click on the scrim, not the panel, closes.
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });

  /** Open straight into a sub-view, skipping the command list. */
  function openView(element) {
    open();
    showView(element);
  }

  return { open, close, openView, toggle: () => (isOpen() ? close() : open()), isOpen };
}
