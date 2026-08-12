/* Timer — a countdown for focused work.

   Also the answer to "remind me in twenty minutes": the model opens this
   rather than promising a reminder it has no way to deliver, because nothing
   in this application runs while the tab is closed. */

export const meta = { id: 'timer', label: 'Timer' };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function mount(el, { params = {}, host = {} }) {
  let total = minutesToSeconds(params.minutes);
  let left = total;
  let running = false;
  let tick = 0;
  // Wall-clock deadline rather than a decrementing counter: setInterval is
  // throttled hard in a background tab, so counting ticks would leave the
  // timer minutes slow exactly when it is least being watched.
  let endsAt = 0;

  el.innerHTML = `
    <div class="mod mod--timer">
      <p class="mod__label"></p>
      <div class="mod__clock" role="timer" aria-live="off">00:00</div>
      <div class="mod__bar"><i></i></div>
      <div class="mod__row">
        <button type="button" class="btn" data-act="toggle">Start</button>
        <button type="button" class="btn btn--ghost" data-act="reset">Reset</button>
      </div>
      <div class="mod__row mod__row--quiet">
        <button type="button" class="btn btn--ghost" data-act="add" data-min="5">+5m</button>
        <button type="button" class="btn btn--ghost" data-act="add" data-min="10">+10m</button>
        <button type="button" class="btn btn--ghost" data-act="add" data-min="25">+25m</button>
      </div>
    </div>`;

  const label = el.querySelector('.mod__label');
  const clock = el.querySelector('.mod__clock');
  const fill = el.querySelector('.mod__bar i');
  const toggle = el.querySelector('[data-act="toggle"]');

  function setLabel(text) {
    label.textContent = text || 'No label';
    label.dataset.empty = String(!text);
  }

  function paint() {
    clock.textContent = format(left);
    fill.style.width = total > 0 ? `${clamp((1 - left / total) * 100, 0, 100)}%` : '0%';
    toggle.textContent = running ? 'Pause' : left === 0 ? 'Restart' : 'Start';
    el.firstElementChild.dataset.done = String(left === 0 && total > 0);
  }

  function stop() {
    running = false;
    clearInterval(tick);
    tick = 0;
  }

  function finish() {
    stop();
    left = 0;
    paint();
    const what = label.dataset.empty === 'true' ? 'Timer' : label.textContent;
    if (host.toast) host.toast(`${what} — time`, 'good');
    if (host.announce) host.announce(`${what}: time is up.`);
  }

  function start() {
    if (left === 0) left = total;
    if (left === 0) return;
    running = true;
    endsAt = Date.now() + left * 1000;
    clearInterval(tick);
    tick = setInterval(() => {
      left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      if (left === 0) finish();
      else paint();
    }, 250);
    paint();
  }

  el.addEventListener('click', (e) => {
    const button = e.target.closest('[data-act]');
    if (!button) return;
    const act = button.dataset.act;
    if (act === 'toggle') return running ? (stop(), paint()) : start();
    if (act === 'reset') {
      stop();
      left = total;
      return paint();
    }
    if (act === 'add') {
      const extra = Number(button.dataset.min) * 60;
      total += extra;
      left += extra;
      if (running) endsAt += extra * 1000;
      paint();
    }
  });

  setLabel(typeof params.label === 'string' ? params.label.slice(0, 60) : '');
  paint();
  if (total > 0) start();

  return {
    update(next = {}) {
      if (typeof next.label === 'string') setLabel(next.label.slice(0, 60));
      if (next.minutes != null) {
        stop();
        total = minutesToSeconds(next.minutes);
        left = total;
        paint();
        if (total > 0) start();
      }
    },
    destroy: stop,
  };
}

function minutesToSeconds(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return 25 * 60; // a sane default beats a zero
  return Math.round(clamp(value, 1, 240) * 60);
}

function format(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
