/*
 * Tiro al vuelo — un juego de puntería con la pistola de agua de Cuerdas de luz.
 * Hecho por Darth Fafo & Claude · https://github.com/darthfafo/cuerdas-de-luz
 *
 * Hacé una pistolita con la mano y aparece la pistola. Apuntá a la pantalla (como con una pistola de luz)
 * y cerrá el índice para disparar agua: mojá globos, aviones de papel y estrellas antes de que se escapen.
 *
 * Cámara → MediaPipe (puntos 3D de la mano) → hacia dónde apunta el caño → mira en la pantalla
 * Blancos y pistola en 3D con three.js, efectos de agua en un lienzo 2D, sonidos sintetizados con Web Audio.
 */
import { IS_TOUCH, testVideoUrl, openCamera, closeCamera, cameraErrorMessage, canRetryCamera, coverMap } from "../lib/camera.js?v=20261124b";
import { loadVision } from "../lib/vision.js?v=20261124b";
import { clamp, clamp01, dist, isGunShape, isThumbCocked, isGripShape, indexBend, handPose3D } from "../lib/gestures.js?v=20261124b";
import { loadThree, randomGunStyle, easeOutBack, makeEnvironment, disposeObject, orientGun, buildGunModel, animateGun, starShape } from "../lib/gun3d.js?v=20261124b";

// ───────────────────────── Configuración ─────────────────────────
const GAME_SECONDS = 60;
const FIRST_HOLD_MS = 1500;   // la primera vez hay que sostener la pistolita un poco más
const HOLD_MS = 700;          // después, para volver a sacarla
const LOST_MS = 900;          // cuánto aguanta la pistola si se pierde la mano o se abre
const FOV = 50;
const HIT_SLACK = 46;         // ayuda de puntería: píxeles extra alrededor de cada blanco
const TANK_DRAIN = 0.3;       // tanque por segundo disparando
const TANK_FILL = 0.25;       // tanque por segundo sin disparar
const RING_LEN = 2 * Math.PI * 62;
const RECORD_KEY = "tiroAlVuelo.record";
const TEST_VIDEO = testVideoUrl();

const TYPES = {
  globo:    { points: 100, tough: 0.22 }, // tough: segundos de chorro que aguanta
  avion:    { points: 150, tough: 0.3 },
  estrella: { points: 500, tough: 0.12 },
  inicio:   { points: 0,   tough: 0.18 }, // el globo de "empezar"
};
const BALLOON_COLORS = [0xff4d6d, 0xffb703, 0x4cc9f0, 0x80ed99, 0xc77dff, 0xff8fab, 0x3a86ff];
const PAPER_COLORS = [0xfbfaf5, 0xdff1ff, 0xffe8ef, 0xfff6cf];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const lerp = (a, b, t) => a + (b - a) * t;
const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;

// ───────────────────────── DOM ─────────────────────────
const $ = (id) => document.getElementById(id);
const video = $("video"), bg = $("bg"), glCanvas = $("gl"), fx = $("fx");
const bctx = bg.getContext("2d"), ctx = fx.getContext("2d");
const ui = {
  intro: $("intro"), ring: $("ring"), prog: $("prog"), status: $("status"),
  introActions: $("introActions"), retry: $("retryBtn"), pointerBtn: $("pointerBtn"),
  score: $("score"), combo: $("combo"), time: $("time"), tank: $("tank"), tankFill: $("tankFill"), sound: $("soundBtn"),
  count: $("count"), label: $("label"), hint: $("hint"),
  results: $("results"), resScore: $("resScore"), resRecord: $("resRecord"), resStats: $("resStats"), again: $("againBtn"),
  toast: $("toast"),
};

// ───────────────────────── Estado ─────────────────────────
let phase = "intro";          // intro → ready → countdown → play ⇄ pause → over → ready…
let input = "hand";           // "hand" (pistola con la mano) o "pointer" (mouse / dedo)
let gun = null, gunFound = false;
let cal = { x: 0, y: 0 }, sensitivity = 1;
const aim = { x: 0, y: 0, valid: false, over: null };
let ammo = 1, firing = false, spraying = false, emptyWarned = false;
let score = 0, combo = 0, mult = 1, timeLeft = GAME_SECONDS, elapsed = 0, spawnTimer = 0, lastTick = 0;
const stats = { globo: 0, avion: 0, estrella: 0, escapes: 0 };
const targets = [], particles = [], popups = [], glass = [];
let startTarget = null, countdownLeft = 0, lastCount = 0;
const pointer = { x: 0, y: 0, down: false, lastMove: -1e9, burstUntil: 0 };

// ───────────────────────── Lienzos ─────────────────────────
let W = 0, H = 0, DPR = 1;
const D0 = () => (H / 2) / Math.tan((FOV * Math.PI) / 360); // a esta profundidad, 1 unidad 3D = 1 píxel
function resize() {
  W = innerWidth; H = innerHeight;
  DPR = Math.max(1, Math.min(devicePixelRatio || 1, 2, Math.sqrt(4.2e6 / Math.max(1, W * H))));
  for (const c of [bg, fx]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
  bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (g3) { g3.renderer.setSize(W, H, false); g3.camera.aspect = W / H; g3.camera.updateProjectionMatrix(); }
  if (!aim.x) { aim.x = W / 2; aim.y = H / 2; }
  if (!pointer.x) { pointer.x = W / 2; pointer.y = H / 2; }
}
addEventListener("resize", resize);

// Proyección de un punto 3D a la pantalla (la cámara 3D está en el origen mirando hacia -z).
function project(p) {
  const s = D0() / Math.max(1, -p.z);
  return { x: W / 2 + p.x * s, y: H / 2 - p.y * s, s };
}

// ───────────────────────── Avisos ─────────────────────────
let toastTimer = 0;
function toast(msg, ms = 2600) {
  ui.toast.textContent = msg;
  ui.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), ms);
}
const setStatus = (msg, isError = false) => { ui.status.textContent = msg; ui.status.classList.toggle("error", isError); };
let lastLabel = "", lastHint = "";
const setLabel = (t) => { if (t !== lastLabel) { lastLabel = t; ui.label.textContent = t; } };
const setHint = (t) => { if (t !== lastHint) { lastHint = t; ui.hint.textContent = t; } };
function setCount(n) {
  if (!n) { ui.count.replaceChildren(); return; }
  const s = document.createElement("span"); s.textContent = n; ui.count.replaceChildren(s);
}

// ───────────────────────── Sonido (todo sintetizado) ─────────────────────────
let audio = null, master = null, muted = false, noiseBuf = null, sprayNode = null;
function initAudio() {
  if (audio) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* sin soporte */ }
  audio = new AC();
  master = audio.createGain(); master.gain.value = muted ? 0 : 0.7;
  const comp = audio.createDynamicsCompressor();
  master.connect(comp); comp.connect(audio.destination);
  noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  audio.onstatechange = updateSoundUI;
  return true;
}
function resumeAudio() {
  if (!initAudio()) return;
  if (audio.state !== "running") audio.resume().then(updateSoundUI, () => {});
}
function updateSoundUI() {
  const on = !!audio && audio.state === "running" && !muted;
  ui.sound.classList.toggle("off", !on);
  ui.sound.setAttribute("aria-pressed", String(on));
  ui.sound.setAttribute("aria-label", on ? "Silenciar" : "Activar sonido");
}
function toggleMute() {
  if (!initAudio()) return;
  if (audio.state !== "running") { muted = false; resumeAudio(); } else muted = !muted;
  master.gain.setTargetAtTime(muted ? 0 : 0.7, audio.currentTime, 0.02);
  updateSoundUI();
}
const live = () => audio && audio.state === "running" && !muted;
function tone(freq, { type = "sine", dur = 0.15, vol = 0.2, at = 0, slide = 0 } = {}) {
  if (!live()) return;
  const t0 = audio.currentTime + at;
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
}
function noise({ dur = 0.1, vol = 0.2, type = "highpass", freq = 1200, q = 0.7, to = 0 } = {}) {
  if (!live()) return;
  const t0 = audio.currentTime;
  const src = audio.createBufferSource(); src.buffer = noiseBuf;
  const f = audio.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
  if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = audio.createGain();
  g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0, Math.random() * 0.5); src.stop(t0 + dur + 0.02);
}
const sfx = {
  pop() { noise({ dur: 0.07, vol: 0.5, freq: 1500 }); tone(520, { dur: 0.1, vol: 0.25, slide: 0.3 }); },
  soak() { noise({ dur: 0.3, vol: 0.3, type: "lowpass", freq: 3200, to: 300 }); },
  chime() { [1046.5, 1318.5, 1568, 2093].forEach((f, i) => tone(f, { dur: 0.45, vol: 0.13, at: i * 0.06 })); },
  tick() { tone(1250, { type: "square", dur: 0.04, vol: 0.06 }); },
  empty() { tone(180, { type: "square", dur: 0.06, vol: 0.12 }); },
  combo(n) { tone(440 * Math.pow(2, (n + 2) / 12), { type: "triangle", dur: 0.18, vol: 0.14 }); },
  start() { [523.3, 659.3, 784, 1046.5].forEach((f, i) => tone(f, { type: "triangle", dur: 0.22, vol: 0.16, at: i * 0.09 })); },
  end() { [784, 659.3, 523.3, 392].forEach((f, i) => tone(f, { type: "triangle", dur: 0.3, vol: 0.16, at: i * 0.13 })); },
  found() { tone(660, { type: "triangle", dur: 0.2, vol: 0.18 }); tone(990, { type: "triangle", dur: 0.3, vol: 0.18, at: 0.11 }); },
  // chorro continuo mientras disparás
  spray(on) {
    if (on && !sprayNode && live()) {
      const src = audio.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const f = audio.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1900; f.Q.value = 0.8;
      const g = audio.createGain(); g.gain.value = 0.0001;
      g.gain.exponentialRampToValueAtTime(0.11, audio.currentTime + 0.05);
      src.connect(f); f.connect(g); g.connect(master); src.start();
      sprayNode = { src, g };
    } else if (!on && sprayNode) {
      const { src, g } = sprayNode; sprayNode = null;
      g.gain.setTargetAtTime(0.0001, audio.currentTime, 0.03);
      src.stop(audio.currentTime + 0.15);
    }
  },
};
for (const type of ["pointerdown", "touchend", "click", "keydown"]) addEventListener(type, resumeAudio, { passive: true });

// ───────────────────────── 3D (three.js) ─────────────────────────
let T = null, g3 = null;
async function init3D() {
  T = await loadThree();
  const renderer = new T.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, IS_TOUCH ? 1.5 : 2));
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new T.Scene();
  scene.environment = makeEnvironment(T, renderer);
  scene.add(new T.HemisphereLight(0xffffff, 0x2a3350, 0.7));
  const key = new T.DirectionalLight(0xffffff, 2.2); key.position.set(-0.5, 1, 0.8); scene.add(key);
  const rim = new T.DirectionalLight(0x9fd8ff, 1.0); rim.position.set(1, -0.3, -0.6); scene.add(rim);
  const camera = new T.PerspectiveCamera(FOV, W / H, 1, 1e5);
  g3 = { renderer, scene, camera, geo: makeGeometries() };
}

// Geometrías compartidas por todos los blancos (se crean una vez).
function makeGeometries() {
  // globo: una esfera que se afina hacia abajo
  const balloon = new T.SphereGeometry(1, 40, 28);
  const pos = balloon.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < 0) { const s = 1 + y * 0.28; pos.setX(i, pos.getX(i) * s); pos.setZ(i, pos.getZ(i) * s); }
  }
  balloon.computeVertexNormals();
  const knot = new T.ConeGeometry(0.13, 0.2, 16);
  const stringPts = [];
  for (let i = 0; i <= 24; i++) { const t = i / 24; stringPts.push(new T.Vector3(Math.sin(t * 7) * 0.09 * t, -1.1 - t * 2.3, 0)); }
  const string = new T.BufferGeometry().setFromPoints(stringPts);
  // avión de papel: dos alas y una quilla (la punta mira hacia +x)
  const nose = [1.25, 0, 0], tail = [-1, 0, 0], keel = [-1, -0.32, 0], left = [-1, 0.14, 0.95], right = [-1, 0.14, -0.95];
  const plane = new T.BufferGeometry();
  plane.setAttribute("position", new T.Float32BufferAttribute([...nose, ...tail, ...left, ...nose, ...right, ...tail, ...nose, ...keel, ...tail], 3));
  plane.computeVertexNormals();
  // estrella dorada con bisel
  const star = new T.ExtrudeGeometry(starShape(T, 1, 0.46), { depth: 0.32, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.07, bevelSegments: 3 });
  star.center();
  return { balloon, knot, string, plane, star };
}

// ───────────────────────── Blancos ─────────────────────────
function makeTarget(type) {
  const root = new T.Group();
  const mats = [];
  let color = 0xffffff;
  if (type === "globo" || type === "inicio") {
    color = type === "inicio" ? 0xffe27a : pick(BALLOON_COLORS);
    const mat = new T.MeshPhysicalMaterial({ color, roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, sheen: 0.4, sheenColor: 0xffffff });
    if (type === "inicio") { mat.emissive = new T.Color(0xffb020); mat.emissiveIntensity = 0.35; }
    const body = new T.Mesh(g3.geo.balloon, mat); body.scale.set(0.92, 1.08, 0.92); root.add(body);
    const knot = new T.Mesh(g3.geo.knot, mat); knot.position.y = -1.12; root.add(knot);
    const lineMat = new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
    root.add(new T.Line(g3.geo.string, lineMat));
    mats.push(mat, lineMat);
    root.userData.body = body;
  } else if (type === "avion") {
    color = pick(PAPER_COLORS);
    const mat = new T.MeshStandardMaterial({ color, roughness: 0.92, side: T.DoubleSide, flatShading: true });
    root.add(new T.Mesh(g3.geo.plane, mat));
    mats.push(mat);
  } else {
    color = 0xffcf3f;
    const mat = new T.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.18, emissive: 0xffa000, emissiveIntensity: 0.85, clearcoat: 1 });
    root.add(new T.Mesh(g3.geo.star, mat));
    mats.push(mat);
  }
  g3.scene.add(root);
  return { type, root, mats, color, baseColor: mats[0].color.clone(), t: 0, wet: 0, state: "fly", seed: Math.random() * 100 };
}
function removeTarget(t) {
  g3.scene.remove(t.root);
  for (const m of t.mats) m.dispose(); // las geometrías son compartidas: no se tiran
  const i = targets.indexOf(t);
  if (i >= 0) targets.splice(i, 1);
  if (t === startTarget) startTarget = null;
}

const sizeK = () => clamp(Math.min(W, H) / 800, 0.7, 1.3);
const speedMul = () => 1 + 0.7 * clamp01(elapsed / GAME_SECONDS);

function spawn(type) {
  const t = makeTarget(type);
  const d0 = D0();
  const z = -d0 * rand(1.2, 2.1);
  const hh = (-z / d0) * H / 2, hw = hh * W / H; // mitad del área visible a esa profundidad
  const sm = speedMul(), k = sizeK();
  Object.assign(t, { z0: z, hh, hw });
  if (type === "globo") {
    t.r = 76 * k; t.x0 = rand(-0.8, 0.8) * hw;
    t.pos = { x: t.x0, y: -hh - t.r * 2.4, z };
    t.vy = (2 * hh) / rand(4.6, 6.4) * sm; t.sway = rand(0.04, 0.09) * hw; t.freq = rand(0.5, 0.9);
  } else if (type === "avion") {
    t.r = 72 * k; t.side = Math.random() < 0.5 ? -1 : 1;
    t.pos = { x: t.side * (hw + t.r * 2), y: rand(-0.25, 0.6) * hh, z };
    t.vx = (-t.side * 2 * hw) / rand(3.4, 5) * sm; t.y0 = t.pos.y; t.amp = rand(0.06, 0.14) * hh; t.freq = rand(0.6, 1.1); t.zAmp = rand(0.05, 0.18) * -z;
  } else {
    t.r = 60 * k; t.side = Math.random() < 0.5 ? -1 : 1;
    t.pos = { x: t.side * (hw + t.r * 2), y: rand(-0.15, 0.55) * hh, z };
    t.vx = (-t.side * 2 * hw) / rand(1.9, 2.6) * sm; t.y0 = t.pos.y; t.amp = rand(0.16, 0.28) * hh; t.freq = rand(1.5, 2.3);
  }
  t.root.scale.setScalar(t.r);
  t.root.position.set(t.pos.x, t.pos.y, t.pos.z);
  targets.push(t);
  return t;
}
function spawnStart() {
  if (startTarget) return;
  const t = makeTarget("inicio");
  const d0 = D0(), z = -d0 * 1.5;
  t.r = 84 * sizeK(); t.pos = { x: 0, y: 0.06 * (-z / d0) * H / 2, z }; t.y0 = t.pos.y;
  t.root.scale.setScalar(t.r);
  targets.push(t);
  startTarget = t;
}

// El avión mira hacia donde vuela (la punta del modelo es +x) y se inclina al subir o bajar.
function orientPlane(t, vel) {
  const f = new T.Vector3(vel.x, vel.y, vel.z).normalize();
  const up = new T.Vector3(0, 1, 0).addScaledVector(f, -f.y).normalize();
  const side = new T.Vector3().crossVectors(f, up);
  t.root.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(f, up, side));
  t.root.rotateX(clamp((-vel.y / (Math.abs(vel.x) + 1)) * 1.2, -0.7, 0.7));
}

function updateTargets(dt) {
  const frozen = phase === "pause";
  for (const t of [...targets]) {
    if (frozen && t.state === "fly") continue;
    t.t += dt;
    const prev = { ...t.pos };
    if (t.state === "fly") {
      if (t.type === "globo") {
        t.pos.y += t.vy * dt;
        t.pos.x = t.x0 + Math.sin(t.t * t.freq * 2 * Math.PI + t.seed) * t.sway;
        t.root.rotation.z = Math.sin(t.t * t.freq * 2 * Math.PI + t.seed + 1) * 0.12;
        if (t.pos.y > t.hh + t.r * 2.6) escape(t);
      } else if (t.type === "avion") {
        t.pos.x += t.vx * dt;
        t.pos.y = t.y0 + Math.sin(t.t * t.freq * 2 * Math.PI + t.seed) * t.amp;
        t.pos.z = t.z0 + Math.sin(t.t * 0.7 + t.seed) * t.zAmp;
        orientPlane(t, { x: (t.pos.x - prev.x) / dt, y: (t.pos.y - prev.y) / dt, z: (t.pos.z - prev.z) / dt });
        if (Math.abs(t.pos.x) > t.hw + t.r * 2.5 && Math.sign(t.pos.x) !== t.side) escape(t);
      } else if (t.type === "estrella") {
        t.pos.x += t.vx * dt;
        t.pos.y = t.y0 + Math.sin(t.t * t.freq * 2 * Math.PI + t.seed) * t.amp;
        t.root.rotation.set(Math.sin(t.t * 3) * 0.4, t.t * 5, Math.sin(t.t * 2) * 0.3);
        if (Math.random() < dt * 24) sparkle(project(t.pos), 1); // estela de chispas
        if (Math.abs(t.pos.x) > t.hw + t.r * 2.5 && Math.sign(t.pos.x) !== t.side) escape(t);
      } else { // globo de inicio: flota en el lugar
        t.pos.y = t.y0 + Math.sin(t.t * 1.6) * t.r * 0.15;
        t.root.rotation.z = Math.sin(t.t * 1.1) * 0.08;
      }
      // al mojarse: los globos tiemblan, los aviones se oscurecen
      if (t.wet > 0) {
        if (t.root.userData.body) { const w = 1 + Math.sin(t.t * 60) * 0.04 * t.wet; t.root.userData.body.scale.set(0.92 * w, 1.08 / w, 0.92 * w); }
        if (t.type === "avion") t.mats[0].color.copy(t.baseColor).lerp(new T.Color(0x6f7f8f), t.wet * 0.7);
        t.wet = Math.max(0, t.wet - dt * 0.6); // se seca si dejás de mojarlo
      }
    } else if (t.state === "falling") { // avión mojado: cae girando
      t.fall += 1400 * dt * sizeK();
      t.pos.y -= t.fall * dt; t.pos.x += t.vx * 0.35 * dt;
      t.root.rotateX(7 * dt); t.root.rotateZ(2.5 * dt);
      if (t.pos.y < -t.hh - t.r * 3) removeTarget(t);
    }
    t.root.position.set(t.pos.x, t.pos.y, t.pos.z);
  }
}
function escape(t) {
  removeTarget(t);
  if (phase !== "play") return;
  stats.escapes++;
  if (combo > 0) { combo = 0; mult = 1; }
}

function hitTarget(t, at) {
  if (t.type === "inicio") {
    confetti(at, hex(t.color), 50); sfx.pop();
    removeTarget(t);
    onStartHit();
    return;
  }
  combo++;
  const newMult = Math.min(5, 1 + Math.floor(combo / 3));
  if (newMult > mult) sfx.combo(newMult);
  mult = newMult;
  const pts = TYPES[t.type].points * mult;
  score += pts;
  stats[t.type]++;
  popups.push({ x: at.x, y: at.y - 10, text: `+${pts}`, sub: mult > 1 ? `×${mult}` : "", life: 1, color: t.type === "estrella" ? "#ffd93b" : "#ffffff" });
  if (t.type === "globo") {
    confetti(at, hex(t.color), 44); sfx.pop(); removeTarget(t);
  } else if (t.type === "avion") {
    t.state = "falling"; t.fall = 0; t.mats[0].color.set(0x5f6f7f); splash(at, 22); sfx.soak();
  } else {
    sparkle(at, 40); sfx.chime(); removeTarget(t);
  }
}

// ───────────────────────── Fases del juego ─────────────────────────
function enterReady() {
  phase = "ready";
  ui.intro.classList.add("hide"); ui.intro.inert = true;
  document.body.classList.add("ingame");
  spawnStart();
  updateHUD(true);
}
function onStartHit() {
  ui.results.hidden = true;
  setLabel("");
  phase = "countdown"; countdownLeft = 3.2; lastCount = 0;
}
function startGame() {
  phase = "play";
  score = 0; combo = 0; mult = 1; timeLeft = GAME_SECONDS; elapsed = 0; spawnTimer = 0.5; lastTick = 0;
  Object.assign(stats, { globo: 0, avion: 0, estrella: 0, escapes: 0 });
  ammo = 1;
  sfx.start();
  updateHUD(true);
}
function endGame() {
  phase = "over";
  for (const t of [...targets]) { if (t.state === "fly") { const p = project(t.pos); sparkle(p, 8); } removeTarget(t); }
  sfx.end();
  const record = Number(localStorage.getItem(RECORD_KEY) || 0);
  const isNew = score > record;
  if (isNew) { try { localStorage.setItem(RECORD_KEY, String(score)); } catch { /* sin almacenamiento */ } }
  ui.resScore.textContent = score.toLocaleString("es-AR");
  ui.resRecord.textContent = isNew ? (record ? "¡Nuevo récord!" : "¡Primer récord!") : `Récord: ${record.toLocaleString("es-AR")}`;
  ui.resRecord.classList.toggle("new", isNew);
  const hits = stats.globo + stats.avion + stats.estrella;
  const acc = hits + stats.escapes ? Math.round((hits / (hits + stats.escapes)) * 100) : 0;
  const items = [`🎈 ${stats.globo}`, `✈️ ${stats.avion}`, `⭐ ${stats.estrella}`, `🎯 ${acc}% de puntería`];
  ui.resStats.replaceChildren(...items.map((s) => { const li = document.createElement("li"); li.textContent = s; return li; }));
  ui.results.hidden = false;
  spawnStart(); // disparale para jugar otra vez
}
function pauseGame() {
  if (phase !== "play") return;
  phase = "pause";
  sfx.spray(false);
}
function resumeGame() {
  if (phase === "pause") phase = "play";
}

function updatePhase(dt) {
  if (phase === "countdown") {
    countdownLeft -= dt;
    const n = Math.ceil(countdownLeft - 0.2);
    if (n !== lastCount) { lastCount = n; setCount(n > 0 ? String(n) : ""); if (n > 0) sfx.tick(); }
    if (countdownLeft <= 0) { setCount(""); startGame(); }
  } else if (phase === "play") {
    elapsed += dt; timeLeft -= dt;
    const sec = Math.ceil(timeLeft);
    if (sec <= 10 && sec !== lastTick && sec > 0) { lastTick = sec; sfx.tick(); }
    if (timeLeft <= 0) { timeLeft = 0; endGame(); return; }
    // aparición de blancos: cada vez más seguido, más rápido y con más a la vez
    const p = clamp01(elapsed / GAME_SECONDS);
    spawnTimer -= dt;
    const alive = targets.filter((t) => t.state === "fly").length;
    if (spawnTimer <= 0 && alive < 3 + Math.floor(p * 4)) {
      const r = Math.random();
      spawn(elapsed > 8 && r < 0.08 + 0.06 * p ? "estrella" : r < 0.5 ? "avion" : "globo");
      spawnTimer = lerp(1.5, 0.65, p) * rand(0.75, 1.25);
    }
  }

  // textos de ayuda
  const handMode = input === "hand";
  if (phase === "ready" || phase === "over") {
    setLabel(phase === "over" ? "" : handMode ? "Apuntá al globo y cerrá el índice para empezar" : (IS_TOUCH ? "Tocá el globo para empezar" : "Hacé clic en el globo para empezar"));
  } else if (phase === "pause") {
    setLabel("Pausa · hacé la pistolita para seguir");
  } else if (phase !== "countdown") setLabel("");
  if (startTarget && lastLabel) {
    const p = project(startTarget.pos);
    ui.label.style.top = `${Math.round(p.y + startTarget.r * p.s * 1.5 + 34)}px`;
  } else ui.label.style.top = "50%";
  const inGame = phase === "ready" || phase === "play" || phase === "over";
  setHint(inGame && handMode && gun && !aim.valid ? "Apuntá hacia la pantalla" : inGame && firing && ammo <= 0.02 ? "¡Sin agua! Soltá el gatillo para recargar" : "");
}

// ───────────────────────── Cámara y manos ─────────────────────────
let landmarker = null, cameraStream = null, map = null;
let lastVideoTime = -1, detectCost = 0, nextDetectAt = 0, videoFrames = 0;
const newHand = () => ({ pts: null, world: null, seen: -1e9, holdStart: 0, holdAt: null, charge: 0 });
const handState = { L: newHand(), R: newHand() };
const hasVideo = () => video.readyState >= 2 && video.videoWidth > 0;
const toScreen = (p) => ({ x: W - (map.ox + p.x * map.dw), y: map.oy + p.y * map.dh });

function selectHands(result) {
  let list = (result.landmarks || []).map((lms, i) => {
    const pts = lms.map(toScreen);
    const world = result.worldLandmarks?.[i]?.map((w) => ({ x: -w.x, y: w.y, z: w.z })) || null;
    return { pts, world, size: dist(pts[0], pts[9]), key: result.handedness?.[i]?.[0]?.categoryName === "Left" ? "L" : "R" };
  });
  list = list.sort((a, b) => b.size - a.size).slice(0, 2);
  if (list.length === 2 && list[0].key === list[1].key) {
    const [r, l] = list[0].pts[0].x > list[1].pts[0].x ? list : [list[1], list[0]];
    r.key = "R"; l.key = "L";
  }
  return list;
}

function track(now) {
  if (!landmarker || !hasVideo() || video.currentTime === lastVideoTime || now < nextDetectAt) return;
  lastVideoTime = video.currentTime;
  videoFrames++;
  map = coverMap(video, W, H);
  if (!map) return;
  const t0 = performance.now();
  try {
    processHands(selectHands(landmarker.detectForVideo(video, now)), now);
    // detección adaptativa: en equipos lentos se espacia sola para que la animación no se trabe
    const cost = Math.min(100, performance.now() - t0);
    if (videoFrames > 5) detectCost = detectCost ? detectCost * 0.8 + cost * 0.2 : cost;
    nextDetectAt = now + clamp(detectCost * 2 - 4, 0, 120);
  } catch (e) {
    console.error(e);
  }
}

function processHands(list, now) {
  const seen = new Set();
  for (const h of list) {
    seen.add(h.key);
    const st = handState[h.key];
    st.seen = now; st.pts = h.pts; st.world = h.world;
    if (gun && gun.key === h.key) updateGun(h, now);
    else if (!gun) chargeGun(st, h, now);
  }
  for (const key of ["L", "R"]) {
    if (seen.has(key)) continue;
    const st = handState[key];
    st.holdStart = 0; st.charge = 0;
    if (now - st.seen > 150) st.pts = null;
  }
  if (gun && !gun.pointer && now - handState[gun.key].seen > LOST_MS) dropGun();
}

// Sacar la pistola: pistolita quieta (índice estirado + pulgar arriba) durante un momento.
function chargeGun(st, h, now) {
  const p = h.pts, size = h.size;
  if (!g3 || input !== "hand" || !(phase === "intro" || phase === "pause" || phase === "ready" || phase === "over")) return;
  if (isGunShape(p) && isThumbCocked(p, size)) {
    if (!st.holdStart || dist(p[8], st.holdAt) > size * 0.8) { st.holdStart = now; st.holdAt = { ...p[8] }; }
    st.charge = clamp01((now - st.holdStart) / (gunFound ? HOLD_MS : FIRST_HOLD_MS));
    if (st.charge >= 1) spawnGun(h, now);
  } else { st.holdStart = 0; st.charge = 0; }
}
function spawnGun(h, now) {
  gun = { key: h.key, style: randomGunStyle(), born: performance.now(), firing: false, bend: 0, lostAt: 0, cal3: null, t3: null, c3: null, model: null };
  handState[h.key].charge = 0; handState[h.key].holdStart = 0;
  if (h.world) poseGun(h, true);
  gunFound = true;
  sfx.found();
  if (phase === "intro") enterReady();
  else if (phase === "pause") resumeGame();
}
function dropGun() {
  if (!gun) return;
  if (gun.model) disposeObject(gun.model.group);
  gun = null;
  firing = false;
  if (phase === "play") pauseGame();
}
function poseGun(h, snap) {
  const pose = handPose3D(h.pts, h.world, snap ? null : gun.cal3, !gun.firing && gun.bend < 0.45);
  gun.cal3 = pose.cal;
  gun.t3 = { f: pose.f, d: pose.d, u: pose.u, ox: pose.ox, oy: pose.oy };
  if (snap || !gun.c3) gun.c3 = { f: { ...pose.f }, d: { ...pose.d }, u: pose.u, ox: pose.ox, oy: pose.oy };
}
function updateGun(h, now) {
  if (isGripShape(h.pts, h.world)) gun.lostAt = 0;
  else if (!gun.lostAt) gun.lostAt = now;
  else if (now - gun.lostAt > LOST_MS) { dropGun(); return; } // abriste la mano
  // gatillo: cerrar el índice (con histéresis)
  gun.bend += (indexBend(h.pts, h.world) - gun.bend) * 0.6;
  if (h.world) poseGun(h, false);
  if (!gun.firing && gun.bend > 1.0) gun.firing = true;
  else if (gun.firing && gun.bend < 0.6) gun.firing = false;
}

// ───────────────────────── Puntería ─────────────────────────
// Como una pistola de luz: hacia dónde apunta el caño (en 3D) define el punto de la pantalla.
// Apuntar derecho a la cámara = centro; girar la mano mueve la mira. Se calibra con el primer disparo.
function rawAim() {
  if (!gun?.c3) return null;
  const f = gun.c3.f, toward = -f.z; // > 0: el caño apunta hacia la pantalla
  if (toward < 0.22) return null;
  return { tx: f.x / toward, ty: f.y / toward, hx: (gun.c3.ox - W / 2) * 0.3, hy: (gun.c3.oy - H / 2) * 0.3 };
}
const gainX = () => W * 0.95 * sensitivity, gainY = () => H * 1.25 * sensitivity;
const aimFromRaw = (r) => ({ x: W / 2 + (r.tx - cal.x) * gainX() + r.hx, y: H / 2 + (r.ty - cal.y) * gainY() + r.hy });
function calibrateTo(point) {
  const r = rawAim();
  if (!r) return;
  cal = { x: r.tx - (point.x - W / 2 - r.hx) / gainX(), y: r.ty - (point.y - H / 2 - r.hy) / gainY() };
  aim.x = point.x; aim.y = point.y;
}

let wasFiring = false;
function updateAim(k, now) {
  // el mouse o el dedo mandan si se usaron hace poco (o si se eligió jugar así)
  const usePointer = input === "pointer" || now - pointer.lastMove < 1500;
  let target = null;
  if (usePointer) {
    target = { x: pointer.x, y: pointer.y };
    firing = pointer.down || now < pointer.burstUntil; // un clic corto igual tira un chorrito
  } else if (gun && !gun.pointer) {
    firing = gun.firing;
    // primer disparo frente al globo de inicio: la mira se calibra sobre el globo
    if (firing && !wasFiring && startTarget && (phase === "ready" || phase === "over")) calibrateTo(project(startTarget.pos));
    const r = rawAim();
    if (r) target = aimFromRaw(r);
  } else firing = false;
  wasFiring = firing;
  aim.valid = !!target;
  if (!target) return;
  target.x = clamp(target.x, 0, W); target.y = clamp(target.y, 0, H);
  const a = usePointer ? 1 : 1 - Math.pow(0.55, k);
  aim.x += (target.x - aim.x) * a; aim.y += (target.y - aim.y) * a;
}

// ───────────────────────── Disparo ─────────────────────────
function updateFiring(dt) {
  const canShoot = phase === "ready" || phase === "play" || phase === "over";
  // ¿qué hay bajo la mira? (con ayuda de puntería)
  aim.over = null;
  let best = Infinity;
  if (aim.valid && canShoot) {
    for (const t of targets) {
      if (t.state !== "fly") continue;
      if ((t.type === "inicio") !== (phase !== "play")) continue; // en juego, los de verdad; si no, el de inicio
      const p = project(t.pos);
      const R = t.r * p.s * (t.type === "avion" ? 1.15 : 1) + HIT_SLACK;
      const d = dist(p, aim);
      if (d < R && d < best) { best = d; aim.over = { t, p }; }
    }
  }
  spraying = firing && canShoot && aim.valid && ammo > 0.02;
  if (firing && ammo <= 0.02 && !emptyWarned) { emptyWarned = true; sfx.empty(); }
  if (!firing) emptyWarned = false;
  if (spraying) ammo = Math.max(0, ammo - TANK_DRAIN * dt * (phase === "play" ? 1 : 0.3));
  else if (!firing) ammo = Math.min(1, ammo + TANK_FILL * dt);
  sfx.spray(spraying);
  if (!spraying) return;
  if (aim.over) {
    const { t, p } = aim.over;
    t.wet += dt / TYPES[t.type].tough + dt * 0.6; // (+ lo que se seca por cuadro)
    if (Math.random() < 0.6) splash(p, 2);
    if (t.wet >= 1) hitTarget(t, p);
  } else {
    // el agua pega en el "vidrio" de la pantalla y chorrea
    if (Math.random() < dt * 22) glass.push({ x: aim.x + rand(-22, 22), y: aim.y + rand(-22, 22), r: rand(3, 9), vy: 0, life: 1 });
    if (glass.length > 140) glass.splice(0, glass.length - 140);
    if (Math.random() < 0.5) splash(aim, 1);
  }
}

// ───────────────────────── Efectos 2D (agua, confeti, chispas) ─────────────────────────
function confetti(p, color, n) {
  const colors = [color, "#ffffff", "#ffd93b", "#8ff6ff"];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = rand(2, 9);
    particles.push({ kind: "confetti", x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3, life: 1, decay: rand(0.012, 0.022), color: pick(colors), rot: rand(0, 6), vr: rand(-0.3, 0.3), w: rand(4, 9), h: rand(2, 5) });
  }
}
function splash(p, n) {
  for (let i = 0; i < n; i++) {
    const a = rand(-Math.PI, 0), sp = rand(1.5, 5);
    particles.push({ kind: "drop", x: p.x + rand(-6, 6), y: p.y + rand(-6, 6), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: rand(0.03, 0.05), r: rand(1.2, 3) });
  }
}
function sparkle(p, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = rand(1, 7);
    particles.push({ kind: "spark", x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: rand(0.015, 0.03), hue: rand(35, 55) });
  }
}

function drawFX(k, now) {
  ctx.clearRect(0, 0, W, H);
  // halo dorado de las estrellas (el bonus tiene que verse de lejos)
  for (const t of targets) {
    if (t.type !== "estrella" || t.state !== "fly") continue;
    const p = project(t.pos), r = t.r * p.s * (2.4 + Math.sin(now / 120) * 0.2);
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, "rgba(255,210,80,0.45)"); g.addColorStop(1, "rgba(255,170,0,0)");
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  // gotas en el vidrio
  for (let i = glass.length - 1; i >= 0; i--) {
    const g = glass[i];
    g.vy += 0.015 * k * (g.r / 6); g.y += g.vy * k; g.life -= 0.004 * k;
    if (g.life <= 0 || g.y > H + 20) { glass.splice(i, 1); continue; }
    const grad = ctx.createRadialGradient(g.x - g.r * 0.3, g.y - g.r * 0.3, g.r * 0.1, g.x, g.y, g.r);
    grad.addColorStop(0, `rgba(255,255,255,${0.55 * g.life})`);
    grad.addColorStop(0.5, `rgba(190,230,255,${0.18 * g.life})`);
    grad.addColorStop(1, `rgba(120,190,255,${0.35 * g.life})`);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.ellipse(g.x, g.y, g.r, g.r * (1 + Math.min(0.6, g.vy * 0.3)), 0, 0, Math.PI * 2); ctx.fill();
  }
  // chorro: de la boquilla a la mira
  if (spraying && gun?.nozzle) drawStream(gun.nozzle, aim, now);
  // partículas
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += (p.kind === "spark" ? 0.05 : 0.25) * k; p.vx *= Math.pow(0.98, k);
    p.x += p.vx * k; p.y += p.vy * k; p.life -= p.decay * k;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    if (p.kind === "confetti") {
      p.rot += p.vr * k;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.min(1, p.life * 1.5);
      ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)) + 0.5);
      ctx.restore();
    } else if (p.kind === "drop") {
      ctx.fillStyle = `rgba(200,240,255,${0.85 * p.life})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `hsla(${p.hue},100%,70%,${p.life})`; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2); ctx.stroke();
      ctx.restore();
    }
  }
  if (particles.length > 900) particles.splice(0, particles.length - 900);
  // puntos ganados
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    p.y -= 0.9 * k; p.life -= 0.016 * k;
    if (p.life <= 0) { popups.splice(i, 1); continue; }
    ctx.save(); ctx.globalAlpha = Math.min(1, p.life * 2); ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 8;
    ctx.fillStyle = p.color; ctx.font = "700 26px ui-sans-serif, -apple-system, system-ui, sans-serif";
    ctx.fillText(p.text, p.x, p.y);
    if (p.sub) { ctx.fillStyle = "#ffd93b"; ctx.font = "800 16px ui-sans-serif, -apple-system, system-ui, sans-serif"; ctx.fillText(p.sub, p.x, p.y + 20); }
    ctx.restore();
  }
  drawChargeRing();
  drawCrosshair(now);
}
function drawStream(from, to, now) {
  const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2 - Math.min(120, dist(from, to) * 0.18);
  const path = () => { ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(mx, my, to.x, to.y); };
  ctx.save();
  ctx.lineCap = "round";
  ctx.globalCompositeOperation = "lighter";
  path(); ctx.strokeStyle = "rgba(90,180,255,0.18)"; ctx.lineWidth = 12; ctx.stroke();
  ctx.setLineDash([14, 10]); ctx.lineDashOffset = -now / 6;
  path(); ctx.strokeStyle = "rgba(160,225,255,0.55)"; ctx.lineWidth = 4; ctx.stroke();
  ctx.setLineDash([4, 18]); ctx.lineDashOffset = -now / 4;
  path(); ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 2; ctx.stroke();
  ctx.restore();
}
function drawCrosshair(now) {
  const show = aim.valid && (phase === "ready" || phase === "play" || phase === "over" || phase === "countdown");
  if (!show) return;
  const empty = ammo <= 0.02, over = !!aim.over;
  const color = empty ? "255,107,125" : over ? "255,217,59" : "255,255,255";
  const r = 20 + (over ? 3 * Math.sin(now / 70) : 0) + (spraying ? 2 : 0);
  ctx.save();
  ctx.translate(aim.x, aim.y);
  ctx.shadowColor = `rgba(${color},0.8)`; ctx.shadowBlur = 10;
  ctx.strokeStyle = `rgba(${color},0.95)`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(dx * (r - 6), dy * (r - 6)); ctx.lineTo(dx * (r + 9), dy * (r + 9)); }
  ctx.stroke();
  ctx.fillStyle = `rgba(${color},1)`;
  ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
// Anillo de carga alrededor de la mano mientras sostenés la pistolita (fuera de la pantalla de inicio).
function drawChargeRing() {
  let st = null;
  for (const s of Object.values(handState)) if (s.pts && s.charge > 0.1 && (!st || s.charge > st.charge)) st = s;
  ui.prog.style.strokeDashoffset = String(RING_LEN * (1 - (st ? st.charge : 0)));
  ui.ring.classList.toggle("seen", !!st);
  if (!st || phase === "intro") return;
  const p = st.pts, c = { x: (p[5].x + p[8].x) / 2, y: (p[5].y + p[8].y) / 2 }, r = dist(p[0], p[9]) * 0.8;
  ctx.save(); ctx.lineCap = "round"; ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,.2)"; ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(130,225,255,.95)"; ctx.shadowColor = "rgba(130,225,255,.9)"; ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.arc(c.x, c.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * st.charge); ctx.stroke();
  ctx.restore();
}

// ───────────────────────── Fondo (cámara) ─────────────────────────
const tiny = document.createElement("canvas"), tctx = tiny.getContext("2d");
let blurAmt = 1;
function drawBG(k) {
  const want = phase === "intro" ? 1 : phase === "pause" ? 0.6 : 0;
  blurAmt += (want - blurAmt) * (1 - Math.pow(0.9, k));
  bctx.fillStyle = "#05060a"; bctx.fillRect(0, 0, W, H);
  if (hasVideo()) map = coverMap(video, W, H);
  if (!hasVideo() || !map) {
    const g = bctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, Math.hypot(W, H) * 0.6);
    g.addColorStop(0, "#1b2140"); g.addColorStop(1, "#05060a");
    bctx.fillStyle = g; bctx.fillRect(0, 0, W, H);
    return;
  }
  const { ox, oy, dw, dh } = map;
  bctx.save(); bctx.translate(W, 0); bctx.scale(-1, 1);
  if (blurAmt < 0.98) bctx.drawImage(video, ox, oy, dw, dh);
  if (blurAmt > 0.02) {
    const tw = 48, th = Math.max(1, Math.round((48 * dh) / dw));
    if (tiny.width !== tw || tiny.height !== th) { tiny.width = tw; tiny.height = th; }
    tctx.drawImage(video, 0, 0, tw, th);
    bctx.globalAlpha = blurAmt; bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = "high";
    bctx.drawImage(tiny, ox - 40, oy - 40, dw + 80, dh + 80);
  }
  bctx.restore();
  // la imagen un poco más oscura para que resalten los blancos
  bctx.fillStyle = `rgba(4,6,14,${0.22 + 0.25 * blurAmt})`; bctx.fillRect(0, 0, W, H);
}

// ───────────────────────── 3D por cuadro ─────────────────────────
function draw3D(k, now) {
  if (!g3) return;
  // pistola: en la mano (con la cámara) o abajo a la derecha apuntando a la mira (mouse / dedo)
  const showGun = (input === "hand" && gun?.c3) || (input === "pointer" && phase !== "intro");
  if (showGun) {
    if (input === "pointer" && !gun) gun = { key: null, style: randomGunStyle(), born: performance.now(), firing: false, bend: 0, model: null, pointer: true };
    if (!gun.model) { gun.model = buildGunModel(T, gun.style); g3.scene.add(gun.model.group); }
    const grp = gun.model.group, d0 = D0();
    let F, u, ox, oy;
    if (gun.pointer) {
      ox = W * 0.8; oy = H * 0.88; u = Math.min(W, H) * 0.16;
      const f = { x: (aim.x - ox) / d0, y: (aim.y - oy) / d0, z: 1.4 }; // hacia la mira, adentro de la pantalla
      const n = Math.hypot(f.x, f.y, f.z);
      F = orientGun(T, grp, { x: f.x / n, y: f.y / n, z: f.z / n }, { x: 0, y: 1, z: 0 });
      gun.bend = firing ? 1.2 : 0; gun.firing = firing;
    } else {
      const c = gun.c3, t = gun.t3, a = 1 - Math.pow(0.5, k);
      for (const v of ["f", "d"]) for (const ax of ["x", "y", "z"]) c[v][ax] += (t[v][ax] - c[v][ax]) * a;
      c.u += (t.u - c.u) * a; c.ox += (t.ox - c.ox) * a; c.oy += (t.oy - c.oy) * a;
      ({ u, ox, oy } = c);
      F = orientGun(T, grp, c.f, c.d);
    }
    const age = performance.now() - gun.born;
    const pop = age < 380 ? Math.max(0.01, easeOutBack(age / 380)) : 1;
    grp.scale.setScalar(u * pop);
    grp.position.set(ox - W / 2, H / 2 - oy, -d0);
    animateGun(gun.model, { bend: gun.bend, firing: spraying, level: 0.15 + ammo * 0.75, now });
    grp.updateMatrixWorld();
    const P = new T.Vector3(1.6, 0, 0).applyMatrix4(grp.matrixWorld);
    gun.nozzle = project(P);
    gun.aimDir = F;
  } else if (gun?.pointer && input !== "pointer") {
    disposeObject(gun.model.group); gun = null;
  }
  g3.renderer.render(g3.scene, g3.camera);
}

// ───────────────────────── Marcador ─────────────────────────
const shown = {};
function updateHUD(force = false) {
  const set = (key, el, value, prop = "textContent") => { if (force || shown[key] !== value) { shown[key] = value; el[prop] = value; } };
  set("score", ui.score, score.toLocaleString("es-AR"));
  set("combo", ui.combo, mult > 1 ? `×${mult}` : "");
  const s = Math.ceil(timeLeft);
  set("time", ui.time, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  const low = phase === "play" && s <= 10;
  if (force || shown.low !== low) { shown.low = low; ui.time.classList.toggle("low", low); }
  const fill = Math.round(ammo * 100) / 100;
  if (force || shown.fill !== fill) { shown.fill = fill; ui.tankFill.style.transform = `scaleX(${fill})`; ui.tank.classList.toggle("empty", fill <= 0.02); }
}

// ───────────────────────── Bucle principal ─────────────────────────
let lastFrame = 0;
function frame() {
  requestAnimationFrame(frame); // primero: si algo falla abajo, el bucle sigue vivo
  const now = performance.now();
  const dt = Math.min(0.05, lastFrame ? (now - lastFrame) / 1000 : 0.016);
  lastFrame = now;
  const k = dt * 60;
  track(now);
  updateAim(k, now);
  updatePhase(dt);
  if (g3) { updateTargets(dt); updateFiring(dt); }
  drawBG(k);
  draw3D(k, now);
  drawFX(k, now);
  updateHUD();
}

// ───────────────────────── Controles ─────────────────────────
function startPointerMode() {
  if (!g3) { toast("Esperá un segundo, se está cargando el 3D…"); return; }
  input = "pointer";
  document.body.classList.add("pointer");
  if (gun && !gun.pointer) dropGun();
  if (phase === "intro") enterReady();
}
ui.pointerBtn.addEventListener("click", startPointerMode);
ui.retry.addEventListener("click", boot);
ui.sound.addEventListener("click", toggleMute);
ui.again.addEventListener("click", () => { if (phase === "over") { if (startTarget) removeTarget(startTarget); onStartHit(); } });

fx.addEventListener("pointermove", (e) => {
  pointer.x = e.clientX; pointer.y = e.clientY;
  if (phase !== "intro" && (input === "pointer" || e.pointerType === "mouse")) pointer.lastMove = performance.now();
});
fx.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  pointer.x = e.clientX; pointer.y = e.clientY; pointer.down = true;
  pointer.burstUntil = performance.now() + 280;
  if (phase !== "intro") pointer.lastMove = performance.now();
  try { fx.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
});
const release = () => { pointer.down = false; };
fx.addEventListener("pointerup", release);
fx.addEventListener("pointercancel", release);

addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "m") toggleMute();
  else if (k === "+" || k === "=") { sensitivity = Math.min(2, sensitivity + 0.1); toast(`Sensibilidad de la mira: ${Math.round(sensitivity * 100)}%`); }
  else if (k === "-") { sensitivity = Math.max(0.4, sensitivity - 0.1); toast(`Sensibilidad de la mira: ${Math.round(sensitivity * 100)}%`); }
  else if (k === "enter" && phase === "over") ui.again.click();
});

// Que la pantalla no se apague mientras jugás con las manos.
let wakeLock = null;
async function keepScreenOn() {
  if (document.hidden || wakeLock || !("wakeLock" in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } catch { /* sin soporte */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { pauseGame(); sfx.spray(false); return; }
  if (video.paused && (video.srcObject || video.getAttribute("src"))) video.play().catch(() => {});
  if (phase === "pause" && (input === "pointer" || gun)) resumeGame();
  keepScreenOn();
});

// ───────────────────────── Arranque ─────────────────────────
let threePromise = null, booting = false;
function showIntroError(msg, canRetry) {
  setStatus(msg, true);
  ui.introActions.hidden = !canRetry;
}
async function boot() {
  if (booting) return;
  booting = true;
  ui.introActions.hidden = true;
  setStatus(TEST_VIDEO ? "Usando un video de prueba…" : "Pidiendo permiso para usar la cámara…");
  threePromise ||= init3D().catch((e) => { threePromise = null; throw e; });
  threePromise.catch(() => {});
  const vision = landmarker ? Promise.resolve(null) : loadVision({ numHands: 2 });
  vision.catch(() => {});
  try {
    try {
      closeCamera(video, cameraStream);
      cameraStream = await openCamera(video, { testVideo: TEST_VIDEO, onEnded: () => { toast("Se desconectó la cámara."); dropGun(); } });
    } catch (e) {
      console.warn(e);
      showIntroError(`${cameraErrorMessage(e)} Igual podés jugar con el ${IS_TOUCH ? "dedo" : "mouse"}.`, canRetryCamera(e));
      return;
    }
    setStatus("Cargando el detector de manos (unos 15 MB la primera vez)…");
    try { const v = await vision; if (v) landmarker = v.hands; }
    catch (e) { console.error(e); showIntroError("No se pudo cargar el detector de manos. Revisá tu conexión y tocá Reintentar.", true); return; }
    try { await threePromise; }
    catch (e) { console.error(e); showIntroError("Tu navegador no puede mostrar gráficos 3D (WebGL).", false); return; }
    setStatus("Hacé la pistolita y sostenela quieta");
    keepScreenOn();
  } finally {
    booting = false;
  }
}

// Solo en localhost con ?video=…: deja ver el estado desde la consola para probar sin cámara.
if (TEST_VIDEO) {
  window.__tiro = {
    processHands, handState, targets, project, spawn, rawAim, aimFromRaw, calibrateTo,
    get startTarget() { return startTarget; },
    get state() { return { phase, input, score, combo, mult, ammo, timeLeft, aim: { ...aim, over: !!aim.over }, gun: gun && { style: gun.style.name, firing: gun.firing, bend: gun.bend }, cal, stats: { ...stats } }; },
    get gun() { return gun; },
    setTime(s) { timeLeft = s; },
  };
}

resize();
updateSoundUI();
boot();
requestAnimationFrame(frame);
