/* Checklist — a list that outlives the message that created it.

   Persisted under its own localStorage key rather than inside the session, so
   closing the stage or starting a new conversation doesn't lose a half-ticked
   list. One list at a time; opening a new one replaces it, which is the
   behaviour the tool description promises. */

export const meta = { id: 'checklist', label: 'Checklist' };

const KEY = 'agasa.checklist.v1';

export function mount(el, { params = {}, host = {} }) {
  let state = fromParams(params) || restore() || { title: 'Checklist', items: [] };

  el.innerHTML = `
    <div class="mod mod--list">
      <h2 class="mod__title"></h2>
      <p class="mod__count"></p>
      <ul class="mod__items"></ul>
      <form class="mod__add">
        <label class="sr-only" for="modAdd">Add an item</label>
        <input id="modAdd" type="text" placeholder="Add an item…" autocomplete="off" />
        <button type="submit" class="btn">Add</button>
      </form>
    </div>`;

  const titleEl = el.querySelector('.mod__title');
  const countEl = el.querySelector('.mod__count');
  const list = el.querySelector('.mod__items');
  const form = el.querySelector('.mod__add');
  const field = form.querySelector('input');

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* full or blocked — the list still works, it just won't survive reload */
    }
  }

  function paint() {
    titleEl.textContent = state.title;
    const done = state.items.filter((i) => i.done).length;
    countEl.textContent = state.items.length
      ? `${done} of ${state.items.length} done`
      : 'Nothing on it yet';

    list.innerHTML = '';
    state.items.forEach((item, index) => {
      const row = document.createElement('li');
      row.className = 'mod__item';
      row.dataset.done = String(item.done);

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.done;
      box.id = `chk${index}`;
      box.addEventListener('change', () => {
        item.done = box.checked;
        persist();
        paint();
        if (item.done && state.items.every((i) => i.done) && host.toast) {
          host.toast(`${state.title} — all done`, 'good');
        }
      });

      const text = document.createElement('label');
      text.setAttribute('for', box.id);
      text.textContent = item.text;

      const kill = document.createElement('button');
      kill.type = 'button';
      kill.className = 'mod__kill';
      kill.setAttribute('aria-label', `Remove: ${item.text}`);
      kill.textContent = '×';
      kill.addEventListener('click', () => {
        state.items.splice(index, 1);
        persist();
        paint();
      });

      row.append(box, text, kill);
      list.appendChild(row);
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = field.value.trim().slice(0, 120);
    if (!text) return;
    state.items.push({ text, done: false });
    field.value = '';
    persist();
    paint();
  });

  paint();
  persist();

  return {
    update(next = {}) {
      const replacement = fromParams(next);
      if (!replacement) return;
      state = replacement;
      persist();
      paint();
    },
    destroy() {
      /* nothing running; the list is already on disk */
    },
  };
}

function fromParams(params) {
  const hasItems = Array.isArray(params.items) && params.items.length;
  if (!hasItems && !params.title) return null;
  return {
    title: String(params.title || 'Checklist').slice(0, 80),
    items: (Array.isArray(params.items) ? params.items : [])
      .slice(0, 40)
      .map((text) => ({ text: String(text).slice(0, 120), done: false })),
  };
}

function restore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (parsed && typeof parsed.title === 'string' && Array.isArray(parsed.items)) return parsed;
  } catch {
    /* unreadable — start fresh rather than failing to open */
  }
  return null;
}
