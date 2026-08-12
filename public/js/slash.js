/* Slash commands.

   The registry lives in main.js; this file owns the menu, the filtering and
   the keyboard behaviour. Adding a command is one entry in that array — no
   change here. */

export function createSlash({ input, root, commands }) {
  let matches = [];
  let index = 0;

  const parse = (value) => {
    const m = String(value).match(/^\/(\S*)\s*([\s\S]*)$/);
    if (!m) return null;
    return { name: m[1].toLowerCase(), rest: m[2].trim() };
  };

  /** The command a given input value would run, if any. */
  const resolve = (value) => {
    const parsed = parse(value);
    if (!parsed) return null;
    const command = commands.find(
      (c) => c.name === parsed.name || (c.aliases || []).includes(parsed.name)
    );
    return command ? { command, args: parsed.rest } : null;
  };

  function paint() {
    root.innerHTML = '';
    if (!matches.length) { close(); return; }

    const list = document.createElement('div');
    list.className = 'slash__inner';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Slash commands');

    matches.forEach((command, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'slash__item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === index));
      item.innerHTML = `<b>/${command.name}${command.args ? ' ' + command.args : ''}</b><span></span>`;
      item.lastElementChild.textContent = command.description;
      // mousedown, not click: the textarea must not lose focus first
      item.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      list.appendChild(item);
    });

    root.appendChild(list);
    root.dataset.open = 'true';
  }

  function refresh(value) {
    const parsed = parse(value);
    if (!parsed) { close(); return; }
    matches = commands.filter((c) => c.name.startsWith(parsed.name));
    index = 0;
    paint();
  }

  function close() {
    matches = [];
    root.dataset.open = 'false';
    root.innerHTML = '';
  }

  function move(delta) {
    if (!matches.length) return;
    index = (index + delta + matches.length) % matches.length;
    paint();
  }

  // Completing to `/name ` rather than running it lets a command that takes
  // arguments be typed out; commands without arguments still need one Enter.
  function choose(i = index) {
    const command = matches[i];
    if (!command) return;
    input.value = `/${command.name} `;
    input.focus();
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Returns true when the menu consumed the key. */
  function handleKey(e) {
    if (root.dataset.open !== 'true') return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return true; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); move(-1); return true; }
    if (e.key === 'Tab')       { e.preventDefault(); choose(); return true; }
    if (e.key === 'Escape')    { e.preventDefault(); close(); return true; }
    if (e.key === 'Enter' && matches.length && input.value.trim() === `/${matches[index].name}`) {
      return false; // exact match already typed — let submit run it
    }
    if (e.key === 'Enter' && matches.length > 1) { e.preventDefault(); choose(); return true; }
    return false;
  }

  return { refresh, close, handleKey, resolve, isOpen: () => root.dataset.open === 'true' };
}
