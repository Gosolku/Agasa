/* EvilEye, from React Bits, ported off React and off ogl.
   The shader and the noise generator are the originals, unchanged. ogl
   was doing three things worth keeping — a full-screen triangle, a
   256px repeating noise texture, and a render loop — and all three are
   about twenty lines of plain WebGL, so the dependency buys nothing in
   a page that ships no build step. */

const DEFAULTS = {
  eyeColor:        '#ffffff',
  intensity:       1.1,
  pupilSize:       0.1,
  irisWidth:       0.7,
  glowIntensity:   0.2,
  scale:           0.6,
  noiseScale:      1.3,
  pupilFollow:     0,
  flameSpeed:      0.7,
  backgroundColor: '#000000',
  // Where the eye sits, in CSS pixels from the middle of the viewport, x
  // rightward and y downward. A function is re-read on every resize, which is
  // what lets the offset be stated in terms of the layout around it.
  offset:          { x: 0, y: 0 },
};

function hexToVec3(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function generateNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);

  function hash(x, y, s) {
    let n = x * 374761393 + y * 668265263 + s * 1274126177;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }

  function noise(px, py, freq, seed) {
    const fx = (px / size) * freq;
    const fy = (py / size) * freq;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const w = freq | 0;
    const v00 = hash(((ix % w) + w) % w, ((iy % w) + w) % w, seed);
    const v10 = hash((((ix + 1) % w) + w) % w, ((iy % w) + w) % w, seed);
    const v01 = hash(((ix % w) + w) % w, (((iy + 1) % w) + w) % w, seed);
    const v11 = hash((((ix + 1) % w) + w) % w, (((iy + 1) % w) + w) % w, seed);
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      let amp = 0.4;
      let totalAmp = 0;
      for (let o = 0; o < 8; o++) {
        const f = 32 * (1 << o);
        v += amp * noise(x, y, f, o * 31);
        totalAmp += amp;
        amp *= 0.65;
      }
      v /= totalAmp;
      v = (v - 0.5) * 2.2 + 0.5;
      v = Math.max(0, Math.min(1, v));
      const val = Math.round(v * 255);
      const i = (y * size + x) * 4;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
      data[i + 3] = 255;
    }
  }

  return data;
}

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const fragmentShader = `
precision highp float;

uniform float uTime;
uniform vec3 uResolution;
uniform sampler2D uNoiseTexture;
uniform float uPupilSize;
uniform float uIrisWidth;
uniform float uGlowIntensity;
uniform float uIntensity;
uniform float uScale;
uniform float uNoiseScale;
uniform vec2 uMouse;
uniform float uPupilFollow;
uniform float uFlameSpeed;
uniform vec3 uEyeColor;
uniform vec3 uBgColor;
uniform vec2 uCenter;

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution.xy) / uResolution.y;
  uv -= uCenter;
  uv /= uScale;
  float ft = uTime * uFlameSpeed;

  float polarRadius = length(uv) * 2.0;
  float polarAngle = (2.0 * atan(uv.x, uv.y)) / 6.28 * 0.3;
  vec2 polarUv = vec2(polarRadius, polarAngle);

  vec4 noiseA = texture2D(uNoiseTexture, polarUv * vec2(0.2, 7.0) * uNoiseScale + vec2(-ft * 0.1, 0.0));
  vec4 noiseB = texture2D(uNoiseTexture, polarUv * vec2(0.3, 4.0) * uNoiseScale + vec2(-ft * 0.2, 0.0));
  vec4 noiseC = texture2D(uNoiseTexture, polarUv * vec2(0.1, 5.0) * uNoiseScale + vec2(-ft * 0.1, 0.0));

  float distanceMask = 1.0 - length(uv);

  // Inner ring
  float innerRing = clamp(-1.0 * ((distanceMask - 0.7) / uIrisWidth), 0.0, 1.0);
  innerRing = (innerRing * distanceMask - 0.2) / 0.28;
  innerRing += noiseA.r - 0.5;
  innerRing *= 1.3;
  innerRing = clamp(innerRing, 0.0, 1.0);

  float outerRing = clamp(-1.0 * ((distanceMask - 0.5) / 0.2), 0.0, 1.0);
  outerRing = (outerRing * distanceMask - 0.1) / 0.38;
  outerRing += noiseC.r - 0.5;
  outerRing *= 1.3;
  outerRing = clamp(outerRing, 0.0, 1.0);

  innerRing += outerRing;

  // Inner eye
  float innerEye = distanceMask - 0.1 * 2.0;
  innerEye *= noiseB.r * 2.0;

  // Pupil with cursor tracking
  vec2 pupilOffset = uMouse * uPupilFollow * 0.12;
  vec2 pupilUv = uv - pupilOffset;
  float pupil = 1.0 - length(pupilUv * vec2(9.0, 2.3));
  pupil *= uPupilSize;
  pupil = clamp(pupil, 0.0, 1.0);
  pupil /= 0.35;

  // Outer eye
  float outerEyeGlow = 1.0 - length(uv * vec2(0.5, 1.5));
  outerEyeGlow = clamp(outerEyeGlow + 0.5, 0.0, 1.0);
  outerEyeGlow += noiseC.r - 0.5;
  float outerBgGlow = outerEyeGlow;
  outerEyeGlow = pow(outerEyeGlow, 2.0);
  outerEyeGlow += distanceMask;
  outerEyeGlow *= uGlowIntensity;
  outerEyeGlow = clamp(outerEyeGlow, 0.0, 1.0);
  outerEyeGlow *= pow(1.0 - distanceMask, 2.0) * 2.5;

  // Outer eye bg glow
  outerBgGlow += distanceMask;
  outerBgGlow = pow(outerBgGlow, 0.5);
  outerBgGlow *= 0.15;

  vec3 color = uEyeColor * uIntensity * clamp(max(innerRing + innerEye, outerEyeGlow + outerBgGlow) - pupil, 0.0, 3.0);
  color += uBgColor;

  gl_FragColor = vec4(color, 1.0);
}
`;

export function createEvilEye(canvas, options = {}) {
  const props = { ...DEFAULTS, ...options };

  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false })
          || canvas.getContext('experimental-webgl');

  // A machine without WebGL gets the flat background rather than a broken page.
  if (!gl) return { destroy() {} };

  gl.clearColor(0, 0, 0, 0);

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || 'shader failed to compile');
    }
    return shader;
  }

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexShader));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentShader));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'program failed to link');
  }
  gl.useProgram(program);

  /* ogl's Triangle: one oversized triangle covering the clip volume, with
     uv running 0..2 so the 0..1 square lands on the viewport. */
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const positionLoc = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

  const uvBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 2, 0, 0, 2]), gl.STATIC_DRAW);
  const uvLoc = gl.getAttribLocation(program, 'uv');
  if (uvLoc !== -1) {
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
  }

  // 256 is a power of two, which is what lets REPEAT work in WebGL 1.
  const SIZE = 256;
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    generateNoiseTexture(SIZE));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.activeTexture(gl.TEXTURE0);

  const u = (name) => gl.getUniformLocation(program, name);
  gl.uniform1i(u('uNoiseTexture'), 0);
  gl.uniform1f(u('uPupilSize'), props.pupilSize);
  gl.uniform1f(u('uIrisWidth'), props.irisWidth);
  gl.uniform1f(u('uGlowIntensity'), props.glowIntensity);
  gl.uniform1f(u('uIntensity'), props.intensity);
  gl.uniform1f(u('uScale'), props.scale);
  gl.uniform1f(u('uNoiseScale'), props.noiseScale);
  gl.uniform1f(u('uPupilFollow'), props.pupilFollow);
  gl.uniform1f(u('uFlameSpeed'), props.flameSpeed);
  gl.uniform3fv(u('uEyeColor'), hexToVec3(props.eyeColor));
  gl.uniform3fv(u('uBgColor'), hexToVec3(props.backgroundColor));

  const uTime = u('uTime');
  const uResolution = u('uResolution');
  const uMouse = u('uMouse');
  const uCenter = u('uCenter');

  let w = 0, h = 0;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const nw = Math.max(1, Math.round(innerWidth * dpr));
    const nh = Math.max(1, Math.round(innerHeight * dpr));
    if (nw === w && nh === h) return;
    w = nw; h = nh;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform3f(uResolution, w, h, w / h);

    // The shader measures in half-viewport-heights, so a pixel offset is worth
    // twice as much on a short window as on a tall one.
    const off = typeof props.offset === 'function' ? props.offset() : props.offset;
    gl.uniform2f(uCenter,
      (2 * (off.x || 0)) / innerHeight,
      (-2 * (off.y || 0)) / innerHeight);
  }
  addEventListener('resize', resize, { passive: true });
  resize();

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };

  const onMove = (event) => {
    mouse.tx = (event.clientX / innerWidth) * 2 - 1;
    mouse.ty = -((event.clientY / innerHeight) * 2 - 1);
  };
  const onLeave = () => { mouse.tx = 0; mouse.ty = 0; };

  if (props.pupilFollow) {
    addEventListener('mousemove', onMove, { passive: true });
    addEventListener('mouseleave', onLeave);
  }

  let frame = 0;
  let running = false;

  function update(time) {
    if (!running) return;
    frame = requestAnimationFrame(update);
    resize();
    mouse.x += (mouse.tx - mouse.x) * 0.05;
    mouse.y += (mouse.ty - mouse.y) * 0.05;
    gl.uniform2f(uMouse, mouse.x, mouse.y);
    gl.uniform1f(uTime, time * 0.001);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function start() {
    if (running) return;
    running = true;
    frame = requestAnimationFrame(update);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(frame);
  }

  // A hidden tab paints nothing, so the GPU should not be asked to.
  const onVisibility = () => { if (document.hidden) stop(); else start(); };
  document.addEventListener('visibilitychange', onVisibility);

  // Motion is the whole component, so honour a stated preference against it
  // by drawing a single frame and leaving it still.
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  if (calm.matches) {
    resize();
    gl.uniform2f(uMouse, 0, 0);
    gl.uniform1f(uTime, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } else {
    start();
  }

  return {
    destroy() {
      stop();
      removeEventListener('resize', resize);
      removeEventListener('mousemove', onMove);
      removeEventListener('mouseleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
