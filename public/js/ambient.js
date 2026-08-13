/* The ambient core — the field the whole console sits on.

   A full-bleed 2D canvas behind the interface: luminous strands running
   left to right, drawn as cubic beziers whose control points undulate. Three
   depth layers, each with its own count, amplitude, rate and opacity, so the
   far ones drift while the near ones lead and the stack reads as depth rather
   than as a flat pattern.

   It carries the same four states as the status orb and is driven from the
   same place, so the background agrees with the status line instead of
   telling a second story: idle breathes, streaming winds up and shifts to the
   interactive colour, error goes slack and red, offline nearly stops.

   Constraints worth keeping:
     · no libraries, no assets — procedural, a few hundred lines of maths
     · one rAF loop, stopped dead when the tab is hidden
     · glow is built from stacked strokes, not shadowBlur, which is ruinous
       at full-screen sizes
     · phase is accumulated rather than derived from t·speed, so a change of
       state eases instead of jumping the wave
     · prefers-reduced-motion gets one settled frame and no loop */

const TAU = Math.PI * 2;

const STATES = {
  idle:    { rate: 0.16, amp: 1.00, lift: 0.55, tone: 'kelp'  },
  busy:    { rate: 0.62, amp: 1.55, lift: 1.00, tone: 'iris'  },
  error:   { rate: 0.07, amp: 0.46, lift: 0.34, tone: 'alert' },
  offline: { rate: 0.03, amp: 0.26, lift: 0.20, tone: 'dim'   },
};

/* far → near. `band` is the share of the viewport height the layer may swing
   through, `depth` how far its colour is lifted towards white. */
const LAYERS = [
  { strands: 3, band: 0.30, rate: 0.55, freq: 1.55, alpha: 0.16, width: 1.0, halo: 10, depth: 0.00, phase: 0.0 },
  { strands: 2, band: 0.20, rate: 0.85, freq: 1.15, alpha: 0.26, width: 1.3, halo: 15, depth: 0.18, phase: 1.7 },
  { strands: 2, band: 0.12, rate: 1.30, freq: 0.85, alpha: 0.40, width: 1.7, halo: 21, depth: 0.34, phase: 3.1 },
];

const SEGMENTS = 14;

/** Accepts `#rgb`, `#rrggbb` or any `rgb()/rgba()` form; returns 0–255. */
function parseColour(value, fallbackHex) {
  const raw = String(value || '').trim() || fallbackHex;
  if (raw.startsWith('#')) {
    const h = raw.slice(1);
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full.slice(0, 6), 16);
    if (Number.isNaN(n)) return parseColour(fallbackHex, '#ffffff');
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const parts = raw.match(/-?\d+(?:\.\d+)?/g);
  if (parts && parts.length >= 3) {
    return [Math.round(+parts[0]), Math.round(+parts[1]), Math.round(+parts[2])];
  }
  return parseColour(fallbackHex, '#ffffff');
}

export function createAmbient(canvas) {
  if (!canvas) return inert();

  let ctx = null;
  try {
    ctx = canvas.getContext('2d', { alpha: true });
  } catch { /* fall through */ }
  if (!ctx) return inert();

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let w = 0, h = 0, dpr = 1;
  let running = false;
  let frameId = 0;
  let phase = 0;
  let last = 0;

  // eased towards, never snapped — the wind-up is the tell that it noticed
  const now = { rate: STATES.idle.rate, amp: STATES.idle.amp, lift: STATES.idle.lift };
  let target = STATES.idle;

  function tones() {
    const css = getComputedStyle(document.documentElement);
    const pick = (name, fallbackHex) =>
      parseColour(css.getPropertyValue(name), fallbackHex);
    return {
      kelp:  pick('--kelp', '#46a98c'),
      iris:  pick('--iris', '#00f0ff'),
      alert: pick('--alert', '#c7554f'),
      dim:   pick('--ink-faint', '#5a636d'),
    };
  }

  let palette = tones();
  let base = palette[target.tone] || palette.kelp;

  /* The light theme puts dark text on a pale ground, so the same additive
     strands would wash it out. Ease them right down there. */
  const themeScale = () =>
    document.documentElement.dataset.theme === 'light' ? 0.34 : 1;

  function resize() {
    // A full-bleed canvas at 3× on a phone is a lot of fill for a background.
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    const nw = Math.max(1, Math.round(innerWidth * dpr));
    const nh = Math.max(1, Math.round(innerHeight * dpr));
    if (nw === w && nh === h) return;
    w = nw; h = nh;
    canvas.width = w; canvas.height = h;
  }

  /** One strand, as a chain of cubic beziers with horizontal handles — the
   *  handles are what keep the joins smooth without solving a spline. */
  function strand(centre, band, freq, rate, seed, amp) {
    const pts = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const u = i / SEGMENTS;
      // taper towards both edges so the strands gather into a core rather
      // than running off the sides as stripes
      const envelope = Math.pow(Math.sin(Math.PI * u), 0.65);
      const a = Math.sin(u * freq * TAU + phase * rate + seed) * 0.62;
      const b = Math.sin(u * freq * TAU * 1.7 - phase * rate * 0.7 + seed * 1.3) * 0.38;
      pts.push([u * w, centre + (a + b) * band * h * envelope * amp]);
    }

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const handle = (x1 - x0) / 3;
      ctx.bezierCurveTo(x0 + handle, y0, x1 - handle, y1, x1, y1);
    }
  }

  function draw() {
    resize();
    ctx.clearRect(0, 0, w, h);

    const scale = themeScale();
    if (scale <= 0) return;

    // additive, so crossings brighten and the core builds itself
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const layer of LAYERS) {
      const [r, g, b] = base;
      const lift = layer.depth;
      const colour = [
        Math.round(r + (255 - r) * lift),
        Math.round(g + (255 - g) * lift),
        Math.round(b + (255 - b) * lift),
      ];
      const rgb = `${colour[0]}, ${colour[1]}, ${colour[2]}`;
      const strength = layer.alpha * now.lift * scale;

      for (let s = 0; s < layer.strands; s++) {
        const spread = layer.strands === 1 ? 0 : (s / (layer.strands - 1) - 0.5);
        const centre = h * 0.5 + spread * h * layer.band * 0.9;
        const seed = layer.phase + s * 2.1;

        strand(centre, layer.band, layer.freq, layer.rate, seed, now.amp);

        // halo first, then the filament over it — two strokes of one path is
        // what stands in for a blur here
        ctx.strokeStyle = `rgba(${rgb}, ${strength * 0.16})`;
        ctx.lineWidth = layer.halo * dpr;
        ctx.stroke();

        ctx.strokeStyle = `rgba(${rgb}, ${strength})`;
        ctx.lineWidth = layer.width * dpr;
        ctx.stroke();
      }
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  function step(ms) {
    if (!running) return;
    frameId = requestAnimationFrame(step);

    // seconds, clamped so a backgrounded tab returning doesn't lurch
    const dt = last ? Math.min((ms - last) / 1000, 0.1) : 0.016;
    last = ms;

    const k = 1 - Math.pow(0.001, dt); // frame-rate independent easing
    now.rate += (target.rate - now.rate) * k;
    now.amp  += (target.amp  - now.amp)  * k;
    now.lift += (target.lift - now.lift) * k;

    phase += dt * now.rate * TAU;
    draw();
  }

  function start() {
    if (running || reduced) return;
    running = true;
    last = 0;
    frameId = requestAnimationFrame(step);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(frameId);
  }

  // No point animating a background nobody is looking at.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else start();
  });

  addEventListener('resize', () => { if (!running) draw(); }, { passive: true });

  if (reduced) {
    // one settled frame: the colour still carries the state, it just doesn't
    // move to say so
    Object.assign(now, target);
    draw();
  } else {
    start();
  }

  return {
    setState(name) {
      target = STATES[name] || STATES.idle;
      base = palette[target.tone] || palette.kelp;
      if (reduced) { Object.assign(now, target); draw(); }
    },
    retheme() {
      palette = tones();
      base = palette[target.tone] || palette.kelp;
      if (!running) draw();
    },
    destroy: stop,
  };
}

/* No canvas, no 2D context, or nothing to draw on — the interface is fully
   usable without a background, so this is a no-op rather than a fallback. */
function inert() {
  return { setState() {}, retheme() {}, destroy() {} };
}
