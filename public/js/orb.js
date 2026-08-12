/* The orb, kept but demoted.

   This is the same two-pass idea as the old full-screen version: filaments
   render into an offscreen target, then a second shader reads that target
   back through a sphere — refracting at the rim, adding fresnel and a
   specular hit — which is what makes it read as an object with an inside
   rather than a glowing disc.

   It is now 18px in the status line and it has a job: it *is* the connection
   indicator. Idle it turns over slowly in the system colour; while a reply
   streams it whips up and shifts to the interactive colour; offline or
   errored it goes slack and red. Colours are read from the CSS tokens, so it
   follows the theme.

   Uniform set is cut to the five values that actually animate — everything
   else that used to be tweakable is now a constant in the shader, because at
   this size nothing else is legible anyway. */

const VERT = `#version 300 es
in vec2 position;
void main(){ gl_Position = vec4(position, 0.0, 1.0); }`;

const STRANDS = `#version 300 es
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uGlow;
uniform float uIntensity;
uniform vec3  uColorA;
uniform vec3  uColorB;

out vec4 fragColor;
const float PI = 3.14159265;
const int  STRANDS = 5;

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  uv /= 1.15;

  float e = 0.06 + uIntensity * 0.94;
  float env = pow(max(cos(uv.x * PI * 1.3), 0.0), 5.0);

  vec3 col = vec3(0.0);
  for(int i = 0; i < STRANDS; i++){
    float fi = float(i);
    float ph = fi * 1.7 * 2.2;
    float freq = (2.0 + fi * 0.35) * 1.3;
    float spd = 1.4 + fi * 1.2;
    float tt = uTime * uSpeed;

    float w = sin(uv.x * freq + tt * spd + ph) * 0.60
            + sin(uv.x * freq * 1.1 - tt * spd * 0.7 + ph * 1.7) * 0.40;

    float y = w * (0.1 + 0.02 * e) * env * uAmplitude;
    float d = abs(uv.y - y);
    float thick = (0.001 + 0.05 * e) * (0.35 + env) * 0.42;
    float g = thick / (d + thick * 0.45);
    g = g * g;

    col += mix(uColorA, uColorB, fi / float(STRANDS)) * g * env;
  }

  col *= 0.45 + 0.7 * e;
  col = 1.0 - exp(-col * uGlow);

  float lum = max(max(col.r, col.g), col.b);
  fragColor = vec4(col, clamp(lum, 0.0, 1.0));
}`;

const GLASS = `#version 300 es
precision highp float;

uniform sampler2D uScene;
uniform vec2 uResolution;

out vec4 fragColor;
const float R = 0.46;

vec2 toUv(vec2 p){ return p * (uResolution.y / uResolution) + 0.5; }

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float d = length(p);

  float edge = fwidth(d) * 1.5;
  float mask = 1.0 - smoothstep(R - edge, R + edge, d);
  if(mask <= 0.0){ fragColor = vec4(0.0); return; }

  float z = sqrt(max(R * R - d * d, 0.0)) / R;
  float nd = d / R;

  vec2 dir = d > 0.0 ? p / d : vec2(0.0);
  float lens = smoothstep(0.85, 1.0, nd) * pow(nd, 6.0);
  vec2 offset = -dir * lens * 0.17;
  vec2 disp   = -dir * lens * 0.016;

  vec3 light;
  light.r = texture(uScene, toUv(p + offset - disp)).r;
  light.g = texture(uScene, toUv(p + offset)).g;
  light.b = texture(uScene, toUv(p + offset + disp)).b;

  float fres = pow(1.0 - z, 3.0);
  float spec = pow(max(dot(p / R, normalize(vec2(-0.55, 0.6))), 0.0), 6.0);
  spec *= smoothstep(R, R * 0.55, d);

  vec3 emissive = light + vec3(fres * 0.18) + vec3(spec) * 0.4;
  float a = clamp(max(max(emissive.r, emissive.g), emissive.b), 0.0, 1.0);
  a = a + (0.05 + fres * 0.05) * (1.0 - a);

  fragColor = vec4(emissive * mask, a * mask);
}`;

const STATES = {
  idle:    { speed: 0.34, intensity: 0.42, glow: 1.6,  amplitude: 2.2, tone: 'kelp'  },
  busy:    { speed: 1.60, intensity: 0.78, glow: 2.5,  amplitude: 3.6, tone: 'iris'  },
  error:   { speed: 0.14, intensity: 0.30, glow: 1.2,  amplitude: 1.1, tone: 'alert' },
  offline: { speed: 0.05, intensity: 0.16, glow: 0.9,  amplitude: 0.5, tone: 'dim'   },
};

const TRI = new Float32Array([-1, -1, 3, -1, -1, 3]);

const hexRgb = (hex) => {
  const h = String(hex).trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function link(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'position');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export function createOrb(canvas) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let gl = null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: true, depth: false,
    });
  } catch { /* fall through to the dot */ }

  // No WebGL2 — a plain coloured dot carries the same information.
  if (!gl) return fallback(canvas);

  let progA, progB;
  try {
    progA = link(gl, VERT, STRANDS);
    progB = link(gl, VERT, GLASS);
  } catch {
    return fallback(canvas);
  }

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, TRI, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const uA = (k) => gl.getUniformLocation(progA, k);
  const aTime = uA('uTime'), aRes = uA('uResolution'), aSpeed = uA('uSpeed'),
        aAmp = uA('uAmplitude'), aGlow = uA('uGlow'), aInt = uA('uIntensity'),
        aColA = uA('uColorA'), aColB = uA('uColorB');
  const bRes = gl.getUniformLocation(progB, 'uResolution');

  gl.useProgram(progB);
  gl.uniform1i(gl.getUniformLocation(progB, 'uScene'), 0);

  let tex = null, fbo = null, w = 0, h = 0;

  function allocate(nw, nh) {
    if (tex) gl.deleteTexture(tex);
    if (fbo) gl.deleteFramebuffer(fbo);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, nw, nh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const nw = Math.max(1, Math.round((rect.width || 18) * dpr));
    const nh = Math.max(1, Math.round((rect.height || 18) * dpr));
    if (nw === w && nh === h) return;
    w = nw; h = nh;
    canvas.width = w; canvas.height = h;
    allocate(w, h);
    gl.useProgram(progA); gl.uniform2f(aRes, w, h);
    gl.useProgram(progB); gl.uniform2f(bRes, w, h);
  }

  // eased towards, never snapped — the wind-up is what reads as "it noticed"
  const now = { speed: 0.34, intensity: 0.42, glow: 1.6, amplitude: 2.2 };
  let target = STATES.idle;
  let colA = [0.27, 0.66, 0.55];
  let colB = [0.49, 0.48, 1.0];
  let running = false;
  let frameId = 0;

  function tones() {
    const css = getComputedStyle(document.documentElement);
    const pick = (name, fallbackHex) =>
      hexRgb((css.getPropertyValue(name) || fallbackHex).trim() || fallbackHex);
    return {
      kelp:  pick('--kelp', '#46a98c'),
      iris:  pick('--iris', '#7c7bff'),
      alert: pick('--alert', '#c7554f'),
      dim:   pick('--ink-faint', '#616e7b'),
    };
  }

  let palette = tones();

  function applyTone() {
    const base = palette[target.tone] || palette.kelp;
    colA = base;
    // second colour lifts the far strands so the sphere has some depth to it
    colB = base.map((c) => Math.min(1, c * 0.55 + 0.45));
  }
  applyTone();

  function draw(t) {
    resize();
    gl.bindVertexArray(vao);

    const k = reduced ? 1 : 0.07;
    now.speed     += (target.speed     - now.speed)     * k;
    now.intensity += (target.intensity - now.intensity) * k;
    now.glow      += (target.glow      - now.glow)      * k;
    now.amplitude += (target.amplitude - now.amplitude) * k;

    gl.useProgram(progA);
    gl.uniform1f(aTime, t);
    gl.uniform1f(aSpeed, now.speed);
    gl.uniform1f(aInt, now.intensity);
    gl.uniform1f(aGlow, now.glow);
    gl.uniform1f(aAmp, now.amplitude);
    gl.uniform3fv(aColA, colA);
    gl.uniform3fv(aColB, colB);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(progB);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function loop(ms) {
    if (!running) return;
    frameId = requestAnimationFrame(loop);
    draw(ms * 0.001);
  }

  function start() {
    if (running) return;
    // Reduced motion gets a single settled frame — the colour still carries
    // the state, it just doesn't move to say so.
    if (reduced) { draw(0); return; }
    running = true;
    frameId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(frameId);
  }

  // No point burning a GPU loop on a hidden tab.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else start();
  });

  start();

  return {
    setState(name) {
      target = STATES[name] || STATES.idle;
      applyTone();
      if (reduced) draw(0);
    },
    retheme() {
      palette = tones();
      applyTone();
      if (reduced) draw(0);
    },
    destroy: stop,
  };
}

// A dot that changes colour. Same information, no GPU.
function fallback(canvas) {
  const dot = document.createElement('span');
  dot.className = canvas.className;
  dot.setAttribute('aria-hidden', 'true');
  dot.style.cssText =
    'width:8px;height:8px;border-radius:50%;background:var(--kelp);' +
    'align-self:center;transition:background 200ms ease;';
  canvas.replaceWith(dot);

  const COLOURS = {
    idle: 'var(--kelp)', busy: 'var(--iris)',
    error: 'var(--alert)', offline: 'var(--ink-faint)',
  };
  return {
    setState(name) { dot.style.background = COLOURS[name] || COLOURS.idle; },
    retheme() {},
    destroy() {},
  };
}
