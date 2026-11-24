/*
 * Cuerdas de luz — un instrumento de cuerdas que se toca en el aire.
 * Hecho por Darth Fafo & Claude · https://github.com/darthfafo/cuerdas-de-luz
 *
 * Cámara → MediaPipe (manos + cara) → gestos → física de cuerdas → Canvas 2D + Web Audio
 *                                                                → MediaRecorder (clips)
 * Todo corre en el navegador: ningún cuadro de la cámara sale del dispositivo.
 */

import { IS_TOUCH, testVideoUrl, openCamera, closeCamera, cameraErrorMessage, canRetryCamera, coverMap } from "./lib/camera.js";
import { loadVision } from "./lib/vision.js";
import {
  clamp, clamp01, dist, midpoint, palmCenter, isThumbsUp, isGunShape, isThumbCocked, isGripShape, isFist, indexBend, handPose3D,
} from "./lib/gestures.js";
import { loadThree, randomGunStyle, easeOutBack, makeEnvironment, disposeObject, orientGun, buildGunModel, animateGun } from "./lib/gun3d.js";

// ───────────────────────── Configuración ─────────────────────────
const SITE_URL = "https://darthfafo.github.io/cuerdas-de-luz/";
const SITE_LABEL = "darthfafo.github.io/cuerdas-de-luz";

const REC_SECONDS = 20;          // duración máxima del clip
const COUNTDOWN_MS = 3000;       // cuenta regresiva antes de grabar
const REC_LONG_SIDE = 1280;      // resolución del clip (lado largo)
const THUMB_HOLD_MS = 650;       // cuánto hay que sostener el 👍
const MAX_STRINGS = 14;
const MAX_SPARKS = 500;
const MAX_VOICES = 24;           // notas sonando a la vez
const MAX_CANVAS_PIXELS = 4.2e6; // tope de píxeles del lienzo (pantallas grandes + retina)
const MIN_STRING_PX = 60;
const MASTER_GAIN = 0.6;
const RING_LEN = 2 * Math.PI * 62;
const FONT = 'ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif';

// Celulares y tablets (IS_TOUCH): menos carga, y gestos pensados para cuando una mano sostiene el teléfono.
const NUM_HANDS = IS_TOUCH ? 2 : 4;      // en el celu casi nunca hay otra persona tan cerca
const FACE_EVERY = IS_TOUCH ? 6 : 3;     // cada cuántos cuadros se busca la cara (si no hay barra en los ojos)
const MIN_SOLO_PX = 90;                  // largo mínimo de una cuerda hecha con una sola mano

const SCALES = {
  "pentatónica": [0, 2, 4, 7, 9],
  "menor": [0, 2, 3, 5, 7, 8, 10],
  "cromática": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  "libre": null,
};
const SCALE_NAMES = Object.keys(SCALES);
const HAND_BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];

// Solo en localhost: ?video=ruta/al/clip.mp4 usa un video en vez de la cámara (para probar sin webcam).
const TEST_VIDEO = testVideoUrl();

// ───────────────────────── DOM ─────────────────────────
const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("stage");
const ctx = canvas.getContext("2d");
const ui = {
  intro: $("intro"), ring: $("ring"), prog: $("prog"), status: $("status"),
  introActions: $("introActions"), retry: $("retryBtn"), noCam: $("noCamBtn"), skip: $("skipBtn"),
  rec: $("recBtn"), recLabel: $("recLabel"), recBar: $("recBar"), countdown: $("countdown"),
  eyes: $("eyesBtn"), undo: $("undoBtn"), clear: $("clearBtn"), sound: $("soundBtn"),
  helpBtn: $("helpBtn"), help: $("help"), scaleName: $("scaleName"), toast: $("toast"),
  modal: $("clipModal"), clipVideo: $("clipVideo"), clipInfo: $("clipInfo"),
  clipDownload: $("clipDownload"), clipShare: $("clipShare"), clipDiscard: $("clipDiscard"), clipClose: $("clipClose"),
};

// ───────────────────────── Estado ─────────────────────────
let started = false, startedAt = 0, gateReady = false;
let useCamera = true, showHands = true, showVideo = true, hideEyes = false;
let scaleIdx = 0;
const strings = [];
const sparks = [];
let hueSeed = Math.random() * 360;
let bridge = null;          // cuerda que se está estirando con las manos
const pointers = new Map(); // dedos / mouse apretados: pointerId → trazo en curso

// ───────────────────────── Lienzo ─────────────────────────
let W = 0, H = 0, DPR = 1, bgGradient = null;
function resize() {
  const oldW = W, oldH = H;
  W = innerWidth; H = innerHeight;
  DPR = Math.min(devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, W * H)));
  DPR = Math.max(1, DPR);
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  bgGradient = ctx.createRadialGradient(W * 0.5, H * 0.4, 0, W * 0.5, H * 0.4, Math.hypot(W, H) * 0.6);
  bgGradient.addColorStop(0, "#16121f");
  bgGradient.addColorStop(1, "#000");
  // las cuerdas acompañan el cambio de tamaño de la ventana
  if (oldW && oldH && (oldW !== W || oldH !== H)) {
    const sx = W / oldW, sy = H / oldH;
    for (const s of strings) { s.a.x *= sx; s.a.y *= sy; s.b.x *= sx; s.b.y *= sy; }
  }
}
addEventListener("resize", resize);
resize();

// ───────────────────────── Avisos ─────────────────────────
let toastTimer = 0, toastKey = null;
function toast(msg, { ms = 2600, key = null, action = null } = {}) {
  ui.toast.replaceChildren(document.createTextNode(msg));
  if (action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "toast-action"; b.textContent = action.label;
    b.addEventListener("click", () => { hideToast(); action.fn(); });
    ui.toast.append(b);
  }
  ui.toast.classList.add("show");
  toastKey = key;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => hideToast(), ms);
}
function hideToast(key) {
  if (key && key !== toastKey) return;
  ui.toast.classList.remove("show");
  toastKey = null;
}
function setStatus(msg, isError = false) {
  if (ui.status.textContent !== msg) ui.status.textContent = msg;
  ui.status.classList.toggle("error", isError);
}

// ───────────────────────── Sonido (Karplus-Strong) ─────────────────────────
let audio = null, master = null, recDest = null, muted = false;
const voices = [];

function initAudio() {
  if (audio) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  // iPhone: que suene aunque el teléfono esté en modo silencio (Safari 16.4+)
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* sin soporte */ }
  audio = new AC();
  master = audio.createGain();
  master.gain.value = muted ? 0 : MASTER_GAIN;
  const comp = audio.createDynamicsCompressor();
  const delay = audio.createDelay(); delay.delayTime.value = 0.18;
  const feedback = audio.createGain(); feedback.gain.value = 0.28;
  const wet = audio.createGain(); wet.gain.value = 0.25;
  master.connect(comp);
  master.connect(delay); delay.connect(feedback); feedback.connect(delay); delay.connect(wet); wet.connect(comp);
  comp.connect(audio.destination);
  if (audio.createMediaStreamDestination) { recDest = audio.createMediaStreamDestination(); comp.connect(recDest); }
  audio.onstatechange = updateSoundUI;
  return true;
}
function resumeAudio() {
  if (!initAudio()) return;
  if (audio.state !== "running") audio.resume().then(updateSoundUI, () => {});
  updateSoundUI();
}
function toggleMute() {
  if (!initAudio()) return;
  if (audio.state !== "running") { muted = false; resumeAudio(); }
  else muted = !muted;
  master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, audio.currentTime, 0.02);
  updateSoundUI();
}
function updateSoundUI() {
  const running = !!audio && audio.state === "running";
  const on = running && !muted;
  ui.sound.classList.toggle("off", !on);
  ui.sound.setAttribute("aria-pressed", String(on));
  ui.sound.setAttribute("aria-label", on ? "Silenciar" : "Activar sonido");
  if (started && audio && !running && !muted) toast("Tocá la pantalla o una tecla para activar el sonido 🔊", { ms: 0, key: "sound" });
  else hideToast("sound");
}

function quantize(freq) {
  const scale = SCALES[SCALE_NAMES[scaleIdx]];
  if (!scale) return freq;
  const midi = 69 + 12 * Math.log2(freq / 440);
  let best = midi, bestD = Infinity;
  for (let o = -1; o <= 1; o++) {
    const base = Math.floor(midi / 12) * 12 + o * 12;
    for (const s of scale) { const m = base + s, d = Math.abs(m - midi); if (d < bestD) { bestD = d; best = m; } }
  }
  return 440 * Math.pow(2, (best - 69) / 12);
}

// Un buffer de ruido que se recircula promediándose: suena a cuerda pulsada.
function pluckSound(freq, velocity, pan, pos) {
  if (!audio || audio.state !== "running" || muted) return;
  const sr = audio.sampleRate, len = Math.floor(sr * 2.6);
  const buf = audio.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  const N = Math.max(2, Math.round(sr / freq));
  const ring = new Float32Array(N);
  const p = Math.max(1, Math.round(N * clamp(pos, 0.05, 0.5))); // dónde se pulsa → timbre
  for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
  for (let i = N - 1; i >= p; i--) ring[i] -= ring[i - p];
  const damp = 0.996 + Math.min(0.0035, freq / 1e6);
  for (let i = 0, idx = 0; i < len; i++) {
    const next = idx + 1 === N ? 0 : idx + 1;
    const a = ring[idx];
    out[i] = a;
    ring[idx] = (a + ring[next]) * 0.5 * damp;
    idx = next;
  }
  const src = audio.createBufferSource(); src.buffer = buf;
  const gain = audio.createGain(); gain.gain.value = 0.25 + 0.55 * velocity;
  src.connect(gain);
  if (audio.createStereoPanner) { const pn = audio.createStereoPanner(); pn.pan.value = clamp(pan, -1, 1); gain.connect(pn); pn.connect(master); }
  else gain.connect(master);
  src.onended = () => { const i = voices.indexOf(src); if (i >= 0) voices.splice(i, 1); };
  src.start();
  voices.push(src);
  if (voices.length > MAX_VOICES) { try { voices.shift().stop(); } catch { /* ya terminó */ } }
}

// ───────────────────────── Cuerdas ─────────────────────────
// Cada cuerda vibra como suma de sus 6 primeros modos (armónicos) con amortiguación.
function addString(a, b) {
  hueSeed = (hueSeed + 47) % 360;
  const s = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, hue: hueSeed, modes: [], lastPluck: 0 };
  strings.push(s);
  if (strings.length > MAX_STRINGS) strings.shift();
  pluck(s, 0.5, 0.4, 1);
}
function undoString() {
  const s = strings.pop();
  if (s) spawnSparks(midpoint(s.a, s.b), s.hue, 10);
}
function clearStrings() {
  for (const s of strings) spawnSparks(midpoint(s.a, s.b), s.hue, 10);
  strings.length = 0;
}
function stringFreq(s) {
  const ref = Math.hypot(W, H);
  return quantize(110 * Math.pow(2, 3.2 * (1 - Math.min(1, dist(s.a, s.b) / (ref * 0.9)))));
}
function pluck(s, t, velocity, sign) {
  const now = performance.now() / 1000;
  const L = dist(s.a, s.b);
  const amp = Math.min(38, 6 + velocity * 34) * Math.min(1, L / 300);
  for (let n = 1; n <= 6; n++) {
    const A = amp * Math.sin(n * Math.PI * t) / (n * n) * 1.6;
    s.modes.push({ n, A: A * sign, t0: now, w: 2 * Math.PI * (2.2 + n * 2.6), decay: 1.1 + n * 0.6 });
  }
  if (s.modes.length > 60) s.modes.splice(0, s.modes.length - 60);
  s.lastPluck = now;
  const p = { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
  spawnSparks(p, s.hue, 14 + velocity * 26);
  pluckSound(stringFreq(s), velocity, (p.x / W) * 2 - 1, t);
}
function displacement(s, u, now) {
  let d = 0;
  for (const m of s.modes) { const dt = now - m.t0; d += m.A * Math.exp(-m.decay * dt) * Math.cos(m.w * dt) * Math.sin(m.n * Math.PI * u); }
  return d;
}
function energy(s, now) {
  let e = 0;
  for (const m of s.modes) e += Math.abs(m.A) * Math.exp(-m.decay * (now - m.t0));
  return e;
}
function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}
// Toca toda cuerda que cruce el segmento p0→p1 (dedo, mouse o touch). dt en ms → fuerza.
function pluckAlong(p0, p1, dt) {
  const move = dist(p0, p1);
  if (move < 2) return false;
  const velocity = clamp01(move / Math.max(dt || 16, 8) / 1.5);
  const now = performance.now() / 1000;
  let hit = false;
  for (const s of strings) {
    if (now - s.lastPluck < 0.12) continue;
    const x = segIntersect(s.a, s.b, p0, p1);
    if (!x || x.t < 0.04 || x.t > 0.96) continue;
    const nx = -(s.b.y - s.a.y), ny = s.b.x - s.a.x;
    pluck(s, x.t, Math.max(0.15, velocity), Math.sign((p1.x - p0.x) * nx + (p1.y - p0.y) * ny) || 1);
    hit = true;
  }
  return hit;
}

function spawnSparks(p, hue, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 6;
    sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, hue: hue + (Math.random() * 60 - 30) });
  }
  if (sparks.length > MAX_SPARKS) sparks.splice(0, sparks.length - MAX_SPARKS);
}

// ───────────────────────── Cámara ─────────────────────────
let cameraStream = null;

async function startCamera() {
  stopCamera();
  cameraStream = await openCamera(video, { testVideo: TEST_VIDEO, onEnded: onCameraLost });
}
function stopCamera() {
  closeCamera(video, cameraStream);
  cameraStream = null;
}
function onCameraLost() {
  const msg = "Se desconectó la cámara.";
  if (!started) { showIntroError(msg, true); return; }
  toast(msg, {
    ms: 0, key: "cam",
    action: { label: "Reintentar", fn: () => startCamera().catch((e) => toast(cameraErrorMessage(e), { ms: 7000 })) },
  });
}
const hasVideo = () => useCamera && video.readyState >= 2 && video.videoWidth > 0;

// Mapeo video → pantalla: espejado y recortado para cubrir toda la ventana.
let ox = 0, oy = 0, dw = 0, dh = 0;
function computeMap() {
  const m = coverMap(video, W, H);
  if (m) ({ ox, oy, dw, dh } = m);
}
const toScreen = (p) => ({ x: W - (ox + p.x * dw), y: oy + p.y * dh });

// ───────────────────────── Modelos (MediaPipe) ─────────────────────────
let landmarker = null, faceDetector = null, faceFailed = false, modelsPromise = null;

function loadModels() {
  modelsPromise ||= loadVision({ numHands: NUM_HANDS, face: true }).then(({ hands: h, face }) => {
    landmarker = h;
    // la cara es opcional (persona principal + barra en los ojos): si falla, la app sigue
    face.then((fd) => { faceDetector = fd; }, (err) => {
      faceFailed = true;
      console.warn("No se pudo cargar el detector de caras.", err);
      if (hideEyes) { toast("No se pudo cargar el detector de caras."); setEyes(false); }
    });
  }).catch((err) => { modelsPromise = null; throw err; });
  return modelsPromise;
}

// ───────────────────────── Persona principal ─────────────────────────
// La persona principal es la de la cara más grande (la más cerca de la cámara).
let person = null, eyeBar = null, eyeBarSeen = -1e9;
function updatePerson(now) {
  const dets = faceDetector.detectForVideo(video, now).detections || [];
  let det = null, best = 0;
  for (const d of dets) { const w = d.boundingBox?.width || 0; if (w > best) { best = w; det = d; } }
  if (!det) return;
  const bb = det.boundingBox, vw = video.videoWidth, vh = video.videoHeight;
  const c = toScreen({ x: (bb.originX + bb.width / 2) / vw, y: (bb.originY + bb.height / 2) / vh });
  const w = bb.width / vw * dw;
  if (person && now - person.seen < 500) {
    person.cx += (c.x - person.cx) * 0.4; person.cy += (c.y - person.cy) * 0.4; person.w += (w - person.w) * 0.4; person.seen = now;
  } else person = { cx: c.x, cy: c.y, w, seen: now };

  if (!det.keypoints || det.keypoints.length < 2) return;
  const r = toScreen(det.keypoints[0]), l = toScreen(det.keypoints[1]);
  const target = { cx: (r.x + l.x) / 2, cy: (r.y + l.y) / 2, ang: Math.atan2(l.y - r.y, l.x - r.x), d: dist(r, l) };
  if (target.ang > Math.PI / 2) target.ang -= Math.PI; else if (target.ang < -Math.PI / 2) target.ang += Math.PI;
  if (!eyeBar || now - eyeBarSeen > 400) eyeBar = target;
  else for (const k of ["cx", "cy", "ang", "d"]) eyeBar[k] += (target[k] - eyeBar[k]) * 0.6;
  eyeBarSeen = now;
}

// ───────────────────────── Manos y gestos ─────────────────────────
const newHand = () => ({
  pts: null, seen: -1e9, pinching: false, pinchPos: null, pinchStart: null, soloBlocked: false,
  pinchFrames: 0, releaseFrames: 0, prevTip: null, prevT: 0,
  gun: null, gunHoldStart: 0, gunHoldAt: null, gunCharge: 0, // easter egg
});
const hands = { L: newHand(), R: newHand() };

// Se queda con dos manos como máximo, de la persona principal: una "L" y una "R".
function selectHands(result, now) {
  let list = (result.landmarks || []).map((lms, i) => {
    const pts = lms.map(toScreen);
    // puntos 3D en metros (espejados como la imagen): x derecha, y abajo, z hacia adentro de la pantalla
    const world = result.worldLandmarks?.[i]?.map((w) => ({ x: -w.x, y: w.y, z: w.z })) || null;
    return { pts, world, size: dist(pts[0], pts[9]), key: result.handedness?.[i]?.[0]?.categoryName === "Left" ? "L" : "R" };
  });
  if (!list.length) return [];
  if (person && now - person.seen < 800) {
    list = list.filter((h) => Math.abs(h.pts[0].x - person.cx) < person.w * 4 && h.pts[0].y > person.cy - person.w * 3);
  }
  const maxSize = Math.max(0, ...list.map((h) => h.size));
  list = list.filter((h) => h.size >= maxSize * 0.45).sort((a, b) => b.size - a.size).slice(0, 2);
  if (list.length === 2 && list[0].key === list[1].key) {
    // misma etiqueta dos veces → decide la posición (vista espejada: la derecha a la derecha)
    const [r, l] = list[0].pts[0].x > list[1].pts[0].x ? list : [list[1], list[0]];
    r.key = "R"; l.key = "L";
  }
  return list;
}

function processHands(list, now) {
  const seen = new Set();
  for (const { key, pts, world } of list) {
    seen.add(key);
    const st = hands[key];
    const stale = now - st.seen > 200;
    st.seen = now; st.pts = pts;
    const size = dist(pts[0], pts[9]);
    st.fist = isFist(pts, world);

    // Easter egg: con la pistola en la mano, el índice no pellizca ni toca (dispara agua).
    updateGun(st, pts, size, now, world);
    if (st.gun) { if (st.pinching) endPinch(st); st.prevTip = null; continue; }

    // Pinza: distancia pulgar-índice relativa al tamaño de la mano, con histéresis para que no parpadee.
    const thumb = pts[4], index = pts[8];
    const pd = dist(thumb, index);
    const m = midpoint(thumb, index);
    st.pinchPos = stale || !st.pinchPos ? m : { x: st.pinchPos.x * 0.45 + m.x * 0.55, y: st.pinchPos.y * 0.45 + m.y * 0.55 };
    if (!st.pinching) {
      if (pd < size * 0.28 && fistCharge <= 0.15) { if (++st.pinchFrames >= 2) { st.pinching = true; st.releaseFrames = 0; st.pinchStart = { ...st.pinchPos }; } }
      else st.pinchFrames = 0;
    } else if (pd > size * 0.45) {
      if (++st.releaseFrames >= 2) endPinch(st);
    } else st.releaseFrames = 0;

    // Tocar: la punta del índice cruza una cuerda entre dos cuadros.
    if (!st.pinching && st.prevTip && !stale) pluckAlong(st.prevTip, index, now - st.prevT);
    st.prevTip = index; st.prevT = now;
  }
  for (const key of ["L", "R"]) {
    if (seen.has(key)) continue;
    const st = hands[key];
    if (st.pinching && now - st.seen > 250) endPinch(st);
    if (now - st.seen > 150) { st.prevTip = null; st.pts = null; st.gunHoldStart = 0; st.gunCharge = 0; st.fist = false; }
    if (st.gun && now - st.seen > 400) dropGun(st);
  }
  // Puente: con las dos pinzas cerradas se estira una cuerda; al soltar queda fija.
  // En el celu también vale con una sola mano: pinza, arrastrar y soltar.
  const live = (st) => st.pinching && st.pinchPos && now - st.seen < 250;
  const L = hands.L, R = hands.R;
  checkFists(now);
  if (fistCharge > 0.15) { // cerrar los dos puños no deja una cuerda por accidente
    bridge = null;
    for (const st of [L, R]) if (st.pinching) endPinch(st);
  }
  if (live(L) && live(R)) {
    bridge = { a: { ...L.pinchPos }, b: { ...R.pinchPos }, two: true };
  } else if (bridge?.two) {
    if (dist(bridge.a, bridge.b) > MIN_STRING_PX) addString(bridge.a, bridge.b);
    bridge = null;
    L.soloBlocked = L.pinching; R.soloBlocked = R.pinching; // la mano que sigue cerrada no arranca otra cuerda
  } else if (IS_TOUCH && [L, R].some((st) => live(st) && !st.soloBlocked)) {
    const st = live(L) && !L.soloBlocked ? L : R;
    bridge = { a: { ...st.pinchStart }, b: { ...st.pinchPos }, two: false };
  } else if (bridge) {
    if (dist(bridge.a, bridge.b) > MIN_SOLO_PX) addString(bridge.a, bridge.b);
    bridge = null;
  }
}
// Dos puños cerrados durante 2 segundos: se borran todas las cuerdas.
const FIST_HOLD_MS = 2000;
let fistStart = 0, fistLast = 0, fistCharge = 0, fistDone = false;
function checkFists(now) {
  const L = hands.L, R = hands.R;
  const both = L.fist && R.fist && !L.gun && !R.gun && now - L.seen < 250 && now - R.seen < 250;
  if (!both) {
    if (now - fistLast > 300) { fistStart = 0; fistCharge = 0; fistDone = false; } // aguanta parpadeos del tracking
    return;
  }
  fistLast = now;
  if (!fistStart) fistStart = now;
  fistCharge = clamp01((now - fistStart) / FIST_HOLD_MS);
  if (fistCharge >= 1 && !fistDone) {
    fistDone = true; // no vuelve a borrar hasta que abras las manos
    const had = strings.length;
    clearStrings();
    toast(had ? "🧹 Pantalla limpia" : "🧹 No había cuerdas para borrar", { ms: 1800 });
  }
}
function drawFistCharge() {
  if (fistCharge < 0.1 || fistDone) return;
  for (const st of [hands.L, hands.R]) {
    if (!st.pts) continue;
    const c = palmCenter(st.pts), r = dist(st.pts[0], st.pts[9]) * 0.95;
    ctx.save(); ctx.lineCap = "round"; ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(255,150,190,0.95)"; ctx.shadowColor = "rgba(255,150,190,0.9)"; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(c.x, c.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fistCharge); ctx.stroke();
    ctx.restore();
  }
}
function endPinch(st) { st.pinching = false; st.pinchFrames = 0; st.releaseFrames = 0; st.soloBlocked = false; }

// Pulgar arriba (isThumbsUp, en lib/gestures.js), sostenido un instante, arranca la app.
let thumbHold = 0, lastGateT = 0;
function checkGate(list, now) {
  const dt = lastGateT ? Math.min(100, now - lastGateT) : 16;
  lastGateT = now;
  // en la compu, la mano derecha; en el celu, cualquiera (la otra suele estar sosteniendo el teléfono)
  const candidates = IS_TOUCH ? list : list.filter((h) => h.key === "R");
  const seenHand = candidates.length > 0;
  const up = candidates.some((h) => isThumbsUp(h.pts));
  ui.ring.classList.toggle("seen", seenHand);
  thumbHold = up ? thumbHold + dt : Math.max(0, thumbHold - dt * 2);
  ui.prog.style.strokeDashoffset = String(RING_LEN * (1 - clamp01(thumbHold / THUMB_HOLD_MS)));
  if (gateReady) {
    setStatus(up ? "¡Eso! Mantenelo un toque…" : seenHand ? "Ahora el pulgar para arriba 👍"
      : IS_TOUCH ? "Mostrale una mano a la cámara" : "Mostrale la mano derecha a la cámara");
  }
  if (thumbHold >= THUMB_HOLD_MS) start();
}

// ───────────────────────── Easter egg: pistola de agua ─────────────────────────
// Hacé una "pistolita" con la mano (índice estirado, pulgar para arriba, el resto cerrado)
// y sostenela quieta 2 segundos: aparece una pistola de agua (o una de fantasía).
// Para disparar, cerrá el índice como si apretaras el gatillo de una pistola de verdad.
// Los gestos (isGunShape, isThumbCocked, isGripShape, indexBend) están en lib/gestures.js
// y el modelo 3D en lib/gun3d.js: los comparte el juego "Tiro al vuelo".
const GUN_HOLD_MS = 2000;
const MAX_DROPS = 400;
const drops = [];
let gunFound = false;

function updateGun(st, p, size, now, world) {
  if (!st.gun) {
    // hay que sostener la pistolita quieta (así no salta mientras tocás cuerdas con el índice)
    if (isGunShape(p) && isThumbCocked(p, size) && !st.pinching) {
      if (!st.gunHoldStart || dist(p[8], st.gunHoldAt) > size * 0.8) { st.gunHoldStart = now; st.gunHoldAt = { ...p[8] }; }
      st.gunCharge = clamp01((now - st.gunHoldStart) / GUN_HOLD_MS);
      if (st.gunCharge > 0.25) loadGun3D(); // el 3D se baja mientras cargás, solo si encontraste el easter egg
      if (st.gunCharge >= 1) spawnGun(st, p, size, now, world);
    } else { st.gunHoldStart = 0; st.gunCharge = 0; }
    return;
  }
  const g = st.gun;
  if (isGripShape(p, world)) g.lostAt = 0;
  else if (!g.lostAt) g.lostAt = now;
  else if (now - g.lostAt > 600) { dropGun(st); return; } // abriste la mano: chau pistola

  // Gatillo: cerrar el índice, como en una pistola de verdad (con histéresis para que no titile).
  const bend = indexBend(p, world);
  g.bend += (bend - g.bend) * 0.6;
  // con el índice estirado la pistola se alinea con el dedo; al apretar el gatillo queda firme con la palma
  const calibrate = !g.firing && g.bend < 0.45;
  aimGun(g, p, size, false, calibrate);
  if (world) aim3D(g, p, world, false, calibrate);
  if (!g.firing && g.bend > 1.0) { g.firing = true; squirtSound(1); g.lastSound = now; }
  else if (g.firing && g.bend < 0.6) g.firing = false;
  else if (g.firing && now - g.lastSound > 320) { squirtSound(0.6); g.lastSound = now; }
}
function spawnGun(st, p, size, now, world) {
  const style = randomGunStyle();
  st.gun = { style, born: performance.now(), firing: false, bend: 0, lostAt: 0, lastSound: 0, ox: p[5].x, oy: p[5].y, u: size, fx: 1, fy: 0, vx: 0, vy: 1 };
  st.gunHoldStart = 0; st.gunCharge = 0;
  if (st.pinching) endPinch(st);
  aimGun(st.gun, p, size, true);
  if (world) aim3D(st.gun, p, world, true);
  spawnSparks(midpoint(p[5], p[8]), style.rainbow ? 290 : 195, 40);
  const pan = (p[5].x / W) * 2 - 1;
  pluckSound(quantize(660), 0.5, pan, 0.3);
  setTimeout(() => pluckSound(quantize(990), 0.5, pan, 0.3), 110);
  if (!gunFound) {
    gunFound = true;
    toast(`${style.rainbow ? "✨ ¡Encontraste la pistola de fantasía!" : "💦 ¡Encontraste la pistola de agua!"} Cerrá el índice para disparar.`, {
      ms: 8000, action: { label: "Jugar 🎯", fn: () => { location.href = "juego/"; } },
    });
  }
}
function dropGun(st) {
  const g = st.gun;
  if (g) {
    spawnSparks(g.nozzle || gunPoint(g, 0.5, 0), g.style.rainbow ? 290 : 195, 18);
    if (g.model) disposeGunModel(g.model);
  }
  st.gun = null; st.gunHoldStart = 0; st.gunCharge = 0;
}
// La pistola sigue a la mano: el caño apunta como el índice estirado y la empuñadura va hacia la palma.
// La dirección se guarda relativa a la palma (muñeca → nudillo del índice), así al cerrar el índice
// para disparar la pistola no se tuerce.
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function aimGun(g, p, size, snap, calibrate = true) {
  const palmAng = Math.atan2(p[5].y - p[0].y, p[5].x - p[0].x);
  const fingerAng = Math.atan2(p[8].y - p[5].y, p[8].x - p[5].x);
  if (snap || g.off2 === undefined) g.off2 = wrapAngle(fingerAng - palmAng);
  else if (calibrate) g.off2 += wrapAngle(fingerAng - palmAng - g.off2) * 0.25;
  const fx = Math.cos(palmAng + g.off2), fy = Math.sin(palmAng + g.off2);
  const palm = palmCenter(p);
  const side = Math.sign((palm.x - p[5].x) * -fy + (palm.y - p[5].y) * fx) || 1;
  const t = snap ? 1 : 0.5;
  g.ox += (p[5].x - g.ox) * t; g.oy += (p[5].y - g.oy) * t; g.u += (size - g.u) * t;
  g.fx += (fx - g.fx) * t; g.fy += (fy - g.fy) * t;
  const n = Math.hypot(g.fx, g.fy) || 1; g.fx /= n; g.fy /= n;
  g.vx = -g.fy * side; g.vy = g.fx * side;
}
// Punto de la pistola (en unidades de "tamaño de mano") → pantalla.
const gunPoint = (g, x, y) => ({ x: g.ox + (g.fx * x + g.vx * y) * g.u, y: g.oy + (g.fy * x + g.vy * y) * g.u });

function emitDrops(g, k, now) {
  // con el modelo 3D, el chorro sale de la boquilla real y en la dirección del caño (aunque apunte hacia vos)
  const tip = g.nozzle || gunPoint(g, 1.5, -0.02);
  const dx = g.nozzle ? g.aim.x : g.fx, dy = g.nozzle ? g.aim.y : g.fy;
  const toward = g.nozzle ? Math.max(0, g.aim.z) : 0; // 0 = de costado, 1 = apuntando a la cámara
  const speed = clamp(Math.min(W, H) / 700, 0.6, 1.4);
  const n = Math.max(1, Math.round(3 * k));
  for (let i = 0; i < n; i++) {
    const sp = (9 + Math.random() * 4) * speed, spread = (Math.random() - 0.5) * (1.1 + toward * 3);
    drops.push({
      x: tip.x, y: tip.y, life: 1, r: 1.5 + Math.random() * 1.8, grow: toward,
      vx: dx * sp - dy * spread, vy: dy * sp + dx * spread,
      hue: g.style.rainbow ? (now / 4 + Math.random() * 60) % 360 : null,
    });
  }
  if (drops.length > MAX_DROPS) drops.splice(0, drops.length - MAX_DROPS);
}
// Las gotas caen con gravedad; si cruzan una cuerda, la tocan y salpican.
function drawDrops(k) {
  if (!drops.length) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  let w = 0;
  for (const d of drops) {
    const prev = { x: d.x, y: d.y };
    d.vy += 0.32 * k; d.x += d.vx * k; d.y += d.vy * k; d.life -= 0.012 * k;
    if (d.life <= 0 || d.y > H + 20 || d.x < -20 || d.x > W + 20) continue;
    if (strings.length && pluckAlong(prev, d, 16.67 * k)) { spawnSparks(d, d.hue ?? 195, 6); continue; }
    drops[w++] = d;
    const a = d.life;
    const r = d.r * (1 + d.grow * (1 - d.life) * 5); // si vienen hacia la cámara, se agrandan
    ctx.strokeStyle = d.hue === null ? `rgba(140,215,255,${0.35 * a})` : `hsla(${d.hue},100%,72%,${0.4 * a})`;
    ctx.lineWidth = r;
    ctx.beginPath(); ctx.moveTo(d.x - d.vx * 1.3, d.y - d.vy * 1.3); ctx.lineTo(d.x, d.y); ctx.stroke();
    ctx.fillStyle = d.hue === null ? `rgba(225,246,255,${0.9 * a})` : `hsla(${d.hue},100%,88%,${0.9 * a})`;
    ctx.beginPath(); ctx.arc(d.x, d.y, r * 0.8, 0, Math.PI * 2); ctx.fill();
  }
  drops.length = w;
  ctx.restore();
}
function squirtSound(vol) {
  if (!audio || audio.state !== "running" || muted) return;
  const sr = audio.sampleRate, len = Math.floor(sr * 0.18);
  const buf = audio.createBuffer(1, len, sr), data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  const src = audio.createBufferSource(); src.buffer = buf;
  const bp = audio.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2200; bp.Q.value = 0.9;
  const gain = audio.createGain(); gain.gain.value = 0.22 * vol;
  src.connect(bp); bp.connect(gain); gain.connect(master);
  src.start();
}

// ── Versión 3D ──
// three.js se baja recién cuando alguien empieza a hacer la pistolita (no pesa para nadie más).
// La pistola se arma con piezas simples (no hay modelo que descargar) y se dibuja en perspectiva
// solo en un cuadrado alrededor de la mano, que después se copia al lienzo (así también sale en los clips).
const GUN_FOV = 40;
let gl3d = null, gl3dLoading = false, gl3dFailed = false;

function loadGun3D() {
  if (gl3d || gl3dLoading || gl3dFailed) return;
  gl3dLoading = true;
  loadThree()
    .then((T) => { gl3d = initGun3D(T); })
    .catch((e) => { gl3dFailed = true; console.warn("Sin 3D: la pistola queda en 2D.", e); })
    .finally(() => { gl3dLoading = false; });
}
function initGun3D(T) {
  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const scene = new T.Scene();
  scene.environment = makeEnvironment(T, renderer);
  scene.add(new T.HemisphereLight(0xffffff, 0x3a4660, 0.8));
  const key = new T.DirectionalLight(0xffffff, 2.2); key.position.set(-0.6, 1, 1); scene.add(key);
  const rim = new T.DirectionalLight(0x9fd8ff, 1.2); rim.position.set(1, -0.4, -0.8); scene.add(rim);
  return { T, renderer, scene, camera: new T.PerspectiveCamera(GUN_FOV, 1, 1, 50000), box: 0 };
}

// Pose 3D de la mano (handPose3D en lib/gestures.js): hacia dónde apunta el caño (f) y hacia dónde queda
// la palma (d). La dirección se guarda relativa a la palma (cal3), así al cerrar el índice para disparar
// la pistola sigue apuntando derecho.
function aim3D(g, p, w, snap, calibrate = true) {
  const pose = handPose3D(p, w, snap ? null : g.cal3, calibrate);
  g.cal3 = pose.cal;
  g.t3 = { f: pose.f, d: pose.d, u: pose.u, ox: pose.ox, oy: pose.oy };
  if (snap || !g.c3) g.c3 = { f: { ...pose.f }, d: { ...pose.d }, u: pose.u, ox: pose.ox, oy: pose.oy };
}

function disposeGunModel(model) {
  if (gl3d) disposeObject(model.group);
}

function drawGun3D(g, now, k) {
  const { T, renderer, scene, camera } = gl3d;
  if (!g.model) { g.model = buildGunModel(T, g.style); scene.add(g.model.group); }
  // suavizado (a la velocidad de la pantalla, aunque la detección vaya más lenta)
  const c = g.c3, t = g.t3, a = 1 - Math.pow(0.5, k);
  for (const v of ["f", "d"]) for (const ax of ["x", "y", "z"]) c[v][ax] += (t[v][ax] - c[v][ax]) * a;
  c.u += (t.u - c.u) * a; c.ox += (t.ox - c.ox) * a; c.oy += (t.oy - c.oy) * a;
  // orientación de la mano (pantalla) → three.js
  const grp = g.model.group;
  const F = orientGun(T, grp, c.f, c.d);
  const age = performance.now() - g.born;
  const pop = age < 380 ? Math.max(0.01, easeOutBack(age / 380)) : 1;
  const D0 = (H / 2) / Math.tan((GUN_FOV * Math.PI) / 360); // a esta distancia, 1 unidad = 1 píxel
  grp.scale.setScalar(c.u * pop);
  grp.position.set(c.ox - W / 2, H / 2 - c.oy, -D0);

  animateGun(g.model, { bend: g.bend, firing: g.firing, now });
  for (const st of Object.values(hands)) if (st.gun?.model) st.gun.model.group.visible = st.gun === g;

  // se dibuja solo un cuadrado alrededor de la mano
  const box = clamp(Math.ceil((c.u * pop * 5) / 32) * 32, 64, 2048);
  const bx = Math.round(c.ox - box / 2), by = Math.round(c.oy - box / 2);
  if (gl3d.box !== box) { renderer.setSize(box, box, false); gl3d.box = box; }
  camera.aspect = W / H;
  camera.setViewOffset(W, H, bx, by, box, box);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  ctx.drawImage(renderer.domElement, bx, by, box, box);

  // boquilla en pantalla y dirección del caño, para el chorro
  const P = new T.Vector3(1.6, 0, 0).applyMatrix4(grp.matrixWorld);
  const sc = D0 / -P.z;
  g.nozzle = { x: W / 2 + P.x * sc, y: H / 2 - P.y * sc };
  g.aim = { x: F.x, y: -F.y, z: F.z };
  return true;
}

// Anillo de carga mientras sostenés la pistolita.
function drawGunCharge(st) {
  const c = st.gunCharge;
  if (!st.pts || st.gun || c < 0.15) return;
  const p = st.pts, ctr = midpoint(p[5], p[8]), r = dist(p[0], p[9]) * 0.75;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath(); ctx.arc(ctr.x, ctr.y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(130,225,255,0.95)"; ctx.shadowColor = "rgba(130,225,255,0.9)"; ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.arc(ctr.x, ctr.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ((c - 0.15) / 0.85)); ctx.stroke();
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}
function star(cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
}
// La pistola se dibuja en un sistema propio: x hacia adelante (el caño), y hacia la palma (la empuñadura),
// en unidades de "tamaño de mano". Así se mueve, gira y escala con la mano.
function drawWaterGun(g, now) {
  const S = g.style;
  const age = performance.now() - g.born;
  const pop = age < 380 ? Math.max(0.01, easeOutBack(age / 380)) : 1;
  const s = g.u * pop, px = 1 / s; // px = 1 píxel en unidades locales
  ctx.save();
  ctx.translate(g.ox, g.oy);
  ctx.transform(g.fx, g.fy, g.vx, g.vy, 0, 0);
  ctx.scale(s, s);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  const lin = (x0, y0, x1, y1, c0, c1) => { const gr = ctx.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, c0); gr.addColorStop(1, c1); return gr; };

  // empuñadura
  ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 14; ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.moveTo(-0.32, 0.06); ctx.lineTo(0.14, 0.06); ctx.lineTo(0.04, 0.92);
  ctx.quadraticCurveTo(0.02, 1.0, -0.08, 1.0); ctx.lineTo(-0.34, 0.97);
  ctx.quadraticCurveTo(-0.44, 0.95, -0.42, 0.86); ctx.closePath();
  ctx.fillStyle = lin(-0.42, 0, 0.14, 0, S.grip[0], S.grip[1]); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(0,0,0,0.22)"; ctx.lineWidth = 2 * px;
  for (const y of [0.45, 0.6, 0.75]) {
    ctx.beginPath(); ctx.moveTo(-0.32 - 0.125 * (y - 0.06) + 0.07, y); ctx.lineTo(0.14 - 0.116 * (y - 0.06) - 0.07, y); ctx.stroke();
  }
  // guardamonte y gatillo
  ctx.beginPath(); ctx.moveTo(0.12, 0.12); ctx.quadraticCurveTo(0.33, 0.62, 0.54, 0.12);
  ctx.strokeStyle = S.grip[1]; ctx.lineWidth = 0.06; ctx.stroke();
  ctx.save(); ctx.translate(0.27, 0.13); ctx.rotate(0.18 + 0.35 * clamp01((g.bend - 0.2) / 0.9));
  roundRect(-0.03, 0, 0.06, 0.24, 0.03); ctx.fillStyle = S.accent; ctx.fill(); ctx.restore();

  // tanque con agua que se mueve
  roundRect(0.02, -0.66, 0.84, 0.52, 0.16);
  ctx.fillStyle = "rgba(200,240,255,0.25)"; ctx.fill();
  ctx.save(); ctx.clip();
  const level = -0.36 + Math.sin(now / 260) * 0.02;
  ctx.beginPath(); ctx.moveTo(0, 0.1);
  for (let x = 0; x <= 0.9; x += 0.05) ctx.lineTo(x, level + Math.sin(x * 12 + now / 170) * 0.025);
  ctx.lineTo(0.9, 0.1); ctx.closePath();
  ctx.fillStyle = S.rainbow ? lin(0, -0.66, 0.9, 0, "rgba(255,120,220,0.85)", "rgba(120,140,255,0.9)") : lin(0, -0.4, 0, 0, "rgba(90,200,255,0.85)", "rgba(30,120,240,0.95)");
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  for (let i = 0; i < 3; i++) {
    const bx = 0.2 + i * 0.22, by = -0.22 - ((now / 900 + i * 0.37) % 1) * 0.12;
    ctx.beginPath(); ctx.arc(bx, by, 0.022, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  roundRect(0.02, -0.66, 0.84, 0.52, 0.16);
  ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1.5 * px; ctx.stroke();
  roundRect(0.36, -0.76, 0.2, 0.12, 0.04); ctx.fillStyle = S.accent; ctx.fill();

  // cuerpo y caño
  ctx.shadowColor = "rgba(0,0,0,0.3)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
  roundRect(-0.38, -0.2, 1.68, 0.36, 0.14);
  ctx.fillStyle = lin(0, -0.2, 0, 0.16, S.body[0], S.body[1]); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1.5 * px; ctx.stroke();
  roundRect(0.64, -0.2, 0.12, 0.36, 0.02); ctx.fillStyle = S.accent; ctx.fill();
  if (S.rainbow) { star(0.3, -0.02, 0.09); ctx.fillStyle = S.accent; ctx.fill(); }
  roundRect(-0.26, -0.155, 1.36, 0.05, 0.025); ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.fill();

  // boquilla
  roundRect(1.28, -0.11, 0.2, 0.18, 0.05); ctx.fillStyle = S.nozzle; ctx.fill();
  ctx.beginPath(); ctx.arc(1.5, -0.02, 0.045, 0, Math.PI * 2); ctx.fillStyle = S.accent; ctx.fill();
  if (g.firing) {
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath(); ctx.arc(1.56, -0.02, 0.09, 0, Math.PI * 2);
    ctx.fillStyle = S.rainbow ? "rgba(255,170,240,0.5)" : "rgba(170,230,255,0.5)"; ctx.fill();
  }
  ctx.restore();
}

// ───────────────────────── Bucle principal ─────────────────────────
let lastFrame = 0, lastVideoTime = -1, videoFrames = 0, trackErrors = 0;
let detectCost = 0, nextDetectAt = 0;

function track(now) {
  if (!hasVideo() || video.currentTime === lastVideoTime || now < nextDetectAt) return;
  lastVideoTime = video.currentTime;
  videoFrames++;
  computeMap();
  const t0 = performance.now();
  try {
    // la cara se mira cada tantos cuadros, salvo que la barra de los ojos esté activa
    if (faceDetector && (hideEyes || videoFrames % FACE_EVERY === 0)) updatePerson(now);
    if (landmarker) {
      const list = selectHands(landmarker.detectForVideo(video, now), now);
      if (started) processHands(list, now); else checkGate(list, now);
    }
    trackErrors = 0;
    // Detección adaptativa: el tracking ocupa como mucho la mitad del tiempo, el resto queda para dibujar.
    // En una compu rápida corre en cada cuadro; en un celu lento se espacia sola y la animación no se traba.
    // Los primeros cuadros (el modelo "calentando") no cuentan, y los picos se recortan.
    const cost = Math.min(100, performance.now() - t0);
    if (videoFrames > 5) detectCost = detectCost ? detectCost * 0.8 + cost * 0.2 : cost;
    nextDetectAt = now + clamp(detectCost * 2 - 4, 0, 120); // nunca menos de ~8 detecciones por segundo
  } catch (e) {
    if (++trackErrors === 1) console.error(e);
    if (trackErrors === 60) toast("El detector de manos dejó de responder.", { ms: 0, key: "track", action: { label: "Recargar", fn: () => location.reload() } });
  }
}

function frame() {
  requestAnimationFrame(frame); // primero: si algo falla abajo, el bucle sigue vivo
  const now = performance.now();
  const k = lastFrame ? Math.min(3, (now - lastFrame) / 16.67) : 1;
  lastFrame = now;
  track(now);
  render(now, k);
  if (recState === "countdown") tickCountdown(now);
  else if (recState === "recording") tickRecording(now);
}

// ───────────────────────── Dibujo ─────────────────────────
const tiny = document.createElement("canvas");
const tctx = tiny.getContext("2d");
// el filtro de desenfoque del canvas es caro en celulares: ahí alcanza con achicar y agrandar
const USE_BLUR_FILTER = typeof ctx.filter === "string" && !IS_TOUCH;

// Desenfoque fuerte y barato: achicar a 48 px y volver a agrandar.
function drawVideo(blurAmt) {
  if (blurAmt < 1) {
    ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, ox, oy, dw, dh);
    ctx.restore();
  }
  if (blurAmt > 0) {
    const tw = 48, th = Math.max(1, Math.round(48 * dh / dw));
    if (tiny.width !== tw || tiny.height !== th) { tiny.width = tw; tiny.height = th; }
    tctx.drawImage(video, 0, 0, tw, th);
    ctx.save();
    ctx.globalAlpha = blurAmt;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    if (USE_BLUR_FILTER) ctx.filter = "blur(18px) saturate(120%)";
    ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(tiny, ox - 40, oy - 40, dw + 80, dh + 80);
    ctx.restore();
  }
}
function drawEyeBar(now) {
  if (!eyeBar || now - eyeBarSeen > 1200) return;
  ctx.save();
  ctx.translate(eyeBar.cx, eyeBar.cy); ctx.rotate(eyeBar.ang);
  const w = eyeBar.d * 2.5, h = Math.max(18, eyeBar.d * 0.62);
  ctx.fillStyle = "#000";
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.restore();
}
function drawRuler(a, b, hue, alpha) {
  const L = dist(a, b);
  if (L < 10) return;
  const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L, nx = -uy, ny = ux;
  ctx.strokeStyle = `hsla(${hue},100%,88%,${0.4 * alpha})`;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let d = 24, i = 1; d < L; d += 24, i++) {
    const len = i % 5 === 0 ? 8 : 3, x = a.x + ux * d, y = a.y + uy * d;
    ctx.moveTo(x + nx * 4, y + ny * 4); ctx.lineTo(x + nx * (4 + len), y + ny * (4 + len));
  }
  ctx.stroke();
}
function drawEndpoint(p, hue) {
  ctx.strokeStyle = `hsla(${hue},100%,88%,0.75)`;
  ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(p.x - 8, p.y); ctx.lineTo(p.x + 8, p.y); ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x, p.y + 8);
  ctx.lineWidth = 0.5; ctx.stroke();
}
function drawString(s, now) {
  const L = dist(s.a, s.b);
  const nx = -(s.b.y - s.a.y) / L, ny = (s.b.x - s.a.x) / L;
  if (s.modes.length) s.modes = s.modes.filter((m) => Math.abs(m.A) * Math.exp(-m.decay * (now - m.t0)) > 0.05);
  const e = s.modes.length ? Math.min(1, energy(s, now) / 40) : 0;

  ctx.beginPath();
  ctx.moveTo(s.a.x, s.a.y);
  if (s.modes.length) {
    const segs = clamp(Math.floor(L / 8), 24, 120);
    for (let i = 1; i <= segs; i++) {
      const u = i / segs, d = displacement(s, u, now);
      ctx.lineTo(s.a.x + (s.b.x - s.a.x) * u + nx * d, s.a.y + (s.b.y - s.a.y) * u + ny * d);
    }
  } else ctx.lineTo(s.b.x, s.b.y); // en reposo es una recta: no hace falta calcular la onda

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (e > 0.02) { ctx.shadowColor = `hsl(${s.hue},100%,70%)`; ctx.shadowBlur = 4 + 12 * e; } // el brillo caro, solo mientras vibra
  ctx.strokeStyle = `hsla(${s.hue},100%,70%,${0.18 + 0.35 * e})`;
  ctx.lineWidth = 1.6 + 1.6 * e;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `hsla(${s.hue},100%,93%,${0.75 + 0.25 * e})`;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s.a.x + nx * 4, s.a.y + ny * 4); ctx.lineTo(s.b.x + nx * 4, s.b.y + ny * 4);
  ctx.strokeStyle = `hsla(${s.hue},100%,85%,0.08)`; ctx.lineWidth = 0.5; ctx.stroke();
  drawRuler(s.a, s.b, s.hue, 0.6);
  ctx.restore();
  drawEndpoint(s.a, s.hue); drawEndpoint(s.b, s.hue);
}
function drawSparks(k) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineWidth = 0.7;
  const friction = Math.pow(0.97, k);
  let w = 0;
  for (let i = 0; i < sparks.length; i++) {
    const p = sparks[i];
    p.x += p.vx * k; p.y += p.vy * k; p.vy += 0.08 * k; p.vx *= friction; p.vy *= friction; p.life -= 0.022 * k;
    if (p.life <= 0) continue;
    sparks[w++] = p;
    ctx.strokeStyle = `hsla(${p.hue},100%,85%,${p.life * 0.8})`;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 2.5, p.y - p.vy * 2.5); ctx.stroke();
  }
  sparks.length = w;
  ctx.restore();
}
function drawHand(st) {
  const p = st.pts;
  ctx.save();
  ctx.strokeStyle = "rgba(40,230,80,0.9)"; ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [a, b] of HAND_BONES) { ctx.moveTo(p[a].x, p[a].y); ctx.lineTo(p[b].x, p[b].y); }
  ctx.stroke();
  ctx.fillStyle = "rgba(220,20,30,0.95)";
  for (const q of p) { ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
function drawCursor(st) {
  if (!st.pinchPos) return;
  ctx.strokeStyle = st.pinching ? "rgba(255,190,120,0.95)" : "rgba(255,255,255,0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(st.pinchPos.x, st.pinchPos.y, st.pinching ? 5 : 8, 0, Math.PI * 2); ctx.stroke();
}
function drawBridge(b, now) {
  const hue = (hueSeed + 47) % 360;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.shadowColor = `hsl(${hue},100%,70%)`; ctx.shadowBlur = 6;
  ctx.setLineDash([6, 5]); ctx.lineDashOffset = -now / 40;
  ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y);
  ctx.strokeStyle = `hsla(${hue},100%,88%,0.8)`; ctx.lineWidth = 0.8; ctx.stroke();
  ctx.setLineDash([]); ctx.shadowBlur = 0;
  drawRuler(b.a, b.b, hue, 0.8);
  ctx.globalCompositeOperation = "source-over";
  drawEndpoint(b.a, hue); drawEndpoint(b.b, hue);
  const m = midpoint(b.a, b.b);
  ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.font = "11px ui-monospace, monospace";
  ctx.fillText(`${Math.round(dist(b.a, b.b))} px`, m.x + 10, m.y - 10);
  ctx.restore();
}

function render(now, k) {
  ctx.globalCompositeOperation = "source-over";
  if (hasVideo() && showVideo) {
    computeMap();
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    const blur = started ? clamp01(1 - (now - startedAt) / 700) : 1;
    drawVideo(blur);
    if (hideEyes) drawEyeBar(now);
    ctx.fillStyle = `rgba(0,0,0,${0.18 + 0.2 * blur})`; ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = bgGradient; ctx.fillRect(0, 0, W, H);
  }
  const t = now / 1000;
  for (const s of strings) drawString(s, t);
  drawSparks(k);
  if (!started) return;
  for (const st of Object.values(hands)) {
    if (!st.pts || now - st.seen > 150) continue;
    if (showHands) drawHand(st);
    if (!st.gun) drawCursor(st);
    drawGunCharge(st);
  }
  drawFistCharge();
  for (const st of Object.values(hands)) {
    const g = st.gun;
    if (!g) continue;
    if (now - st.seen > 600) { dropGun(st); continue; } // se perdió la mano
    g.nozzle = null;
    let drawn3D = false;
    if (gl3d && g.t3) {
      try { drawn3D = drawGun3D(g, now, k); }
      catch (e) { console.warn("El 3D falló: sigo con la pistola 2D.", e); gl3dFailed = true; gl3d = null; }
    }
    if (!drawn3D) drawWaterGun(g, now); // mientras carga three.js, o si no hay WebGL
    if (g.firing) emitDrops(g, k, now);
  }
  drawDrops(k);
  if (bridge) drawBridge(bridge, now);
  for (const ptr of pointers.values()) {
    if (!ptr.plucked && dist(ptr.start, ptr.cur) > 8) drawBridge({ a: ptr.start, b: ptr.cur }, now);
  }
}

// ───────────────────────── Grabación de clips ─────────────────────────
const CAN_RECORD = typeof window.MediaRecorder === "function" && typeof HTMLCanvasElement.prototype.captureStream === "function";
let recState = "idle"; // idle → countdown → recording → stopping → idle
let recorder = null, recChunks = [], recMime = "", recCanvas = null, recCtx = null, recVideoTrack = null;
let recStart = 0, recStopAt = 0, recStopTimer = 0, countdownStart = 0, lastCountdown = 0, lastRecSec = -1;

function pickMime() {
  const types = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,mp4a", "video/mp4",
    "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
}
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function toggleRecording() {
  if (!started || modalOpen || !CAN_RECORD) return;
  if (recState === "idle") {
    resumeAudio();
    setHelp(false);
    recState = "countdown"; countdownStart = performance.now(); lastCountdown = 0;
  } else if (recState === "countdown") {
    recState = "idle"; ui.countdown.replaceChildren();
  } else if (recState === "recording") {
    stopRecording();
  }
  updateRecUI();
}
function tickCountdown(now) {
  const left = Math.ceil((COUNTDOWN_MS - (now - countdownStart)) / 1000);
  if (left <= 0) { ui.countdown.replaceChildren(); startRecording(); return; }
  if (left !== lastCountdown) {
    lastCountdown = left;
    const n = document.createElement("span"); n.textContent = String(left);
    ui.countdown.replaceChildren(n);
  }
}
function startRecording() {
  // un lienzo aparte, a 1280 px, con la marca de agua: el clip pesa menos y no se graba la interfaz
  const scale = Math.min(REC_LONG_SIDE / Math.max(W, H), DPR);
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  recCanvas = document.createElement("canvas");
  recCanvas.width = even(W * scale); recCanvas.height = even(H * scale);
  recCtx = recCanvas.getContext("2d");
  paintRecFrame();
  try {
    recVideoTrack = recCanvas.captureStream(30).getVideoTracks()[0];
    const stream = new MediaStream([recVideoTrack, ...(recDest ? recDest.stream.getAudioTracks() : [])]);
    recMime = pickMime();
    const opts = { videoBitsPerSecond: 4_500_000, audioBitsPerSecond: 128_000, ...(recMime && { mimeType: recMime }) };
    try { recorder = new MediaRecorder(stream, opts); } catch { recorder = new MediaRecorder(stream); }
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) recChunks.push(e.data); };
    recorder.onstop = finishRecording;
    recorder.onerror = (e) => console.error("Error de grabación", e.error || e);
    recorder.start(1000);
  } catch (e) {
    console.error(e);
    resetRecording();
    toast("Tu navegador no pudo empezar a grabar.");
    return;
  }
  recStart = performance.now(); recStopAt = 0; lastRecSec = -1;
  recState = "recording";
  recStopTimer = setTimeout(stopRecording, REC_SECONDS * 1000);
  updateRecUI();
}
function paintRecFrame() {
  const w = recCanvas.width, h = recCanvas.height, s = Math.min(w, h) / 720;
  recCtx.drawImage(canvas, 0, 0, w, h);
  recCtx.save();
  recCtx.textAlign = "right";
  recCtx.shadowColor = "rgba(0,0,0,.65)"; recCtx.shadowBlur = 8 * s;
  const x = w - 24 * s, y = h - 22 * s;
  recCtx.font = `600 ${Math.round(20 * s)}px ${FONT}`; recCtx.fillStyle = "rgba(255,255,255,.9)";
  recCtx.fillText("cuerdas de luz", x, y - 22 * s);
  recCtx.font = `400 ${Math.round(14 * s)}px ${FONT}`; recCtx.fillStyle = "rgba(255,255,255,.65)";
  recCtx.fillText(SITE_LABEL, x, y);
  recCtx.restore();
}
function tickRecording(now) {
  paintRecFrame();
  const elapsed = (now - recStart) / 1000;
  ui.recBar.style.transform = `scaleX(${clamp01(elapsed / REC_SECONDS)})`;
  const sec = Math.min(REC_SECONDS, Math.floor(elapsed));
  if (sec !== lastRecSec) { lastRecSec = sec; ui.recLabel.textContent = `${fmtTime(sec)} / ${fmtTime(REC_SECONDS)}`; }
}
function stopRecording() {
  clearTimeout(recStopTimer);
  if (recState !== "recording") return;
  recState = "stopping"; recStopAt = performance.now();
  updateRecUI();
  try { recorder.stop(); } catch { finishRecording(); }
}
function finishRecording() {
  const type = recorder?.mimeType || recMime || "video/webm";
  const blob = new Blob(recChunks, { type });
  const seconds = Math.max(1, Math.round(((recStopAt || performance.now()) - recStart) / 1000));
  resetRecording();
  if (!blob.size) { toast("No se pudo guardar el clip. Probá de nuevo."); return; }
  openClip(blob, type, seconds);
}
function resetRecording() {
  clearTimeout(recStopTimer);
  recVideoTrack?.stop();
  recVideoTrack = null; recorder = null; recChunks = []; recCanvas = null; recCtx = null;
  recState = "idle";
  ui.countdown.replaceChildren();
  updateRecUI();
}
function updateRecUI() {
  const r = ui.rec;
  r.classList.toggle("arming", recState === "countdown");
  r.classList.toggle("recording", recState === "recording" || recState === "stopping");
  ui.recBar.classList.toggle("on", recState === "recording");
  if (recState === "idle") {
    ui.recLabel.textContent = "Grabar clip";
    ui.recBar.style.transform = "scaleX(0)";
    r.title = "Grabar un clip de 20 segundos (R)"; r.setAttribute("aria-label", "Grabar un clip de 20 segundos");
  } else if (recState === "countdown") {
    ui.recLabel.textContent = "Cancelar";
    r.title = "Cancelar (R)"; r.setAttribute("aria-label", "Cancelar la grabación");
  } else if (recState === "recording") {
    r.title = "Detener (R)"; r.setAttribute("aria-label", "Detener la grabación");
  } else {
    ui.recLabel.textContent = "Guardando…";
  }
}

// ───────────────────────── Clip listo ─────────────────────────
let clip = null, modalOpen = false, focusBeforeModal = null;
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const formatMB = (bytes) => `${(bytes / 1048576).toLocaleString("es-AR", { maximumFractionDigits: 1 })} MB`;

function openClip(blob, type, seconds) {
  const ext = type.includes("mp4") ? "mp4" : "webm";
  clip = { blob, type, name: `cuerdas-de-luz-${stamp()}.${ext}`, url: URL.createObjectURL(blob) };
  ui.clipVideo.src = clip.url;
  ui.clipVideo.play().catch(() => {});
  ui.clipInfo.textContent = `${seconds} s · ${ext.toUpperCase()} · ${formatMB(blob.size)}. ` +
    (ext === "webm" ? "Si alguna app no acepta WebM, convertilo a MP4. " : "") +
    "Si cerrás sin descargar, el clip se pierde.";
  let canShare = false;
  try { canShare = !!navigator.canShare?.({ files: [new File([blob], clip.name, { type })] }); } catch { /* sin soporte */ }
  ui.clipShare.hidden = !canShare;
  focusBeforeModal = document.activeElement;
  ui.modal.hidden = false; modalOpen = true;
  ui.clipDownload.focus();
}
function closeClip() {
  if (!modalOpen) return;
  ui.modal.hidden = true; modalOpen = false;
  ui.clipVideo.pause(); ui.clipVideo.removeAttribute("src"); ui.clipVideo.load();
  if (clip) { const url = clip.url; setTimeout(() => URL.revokeObjectURL(url), 4000); clip = null; }
  (focusBeforeModal && document.contains(focusBeforeModal) ? focusBeforeModal : ui.rec).focus?.();
}
function downloadClip() {
  if (!clip) return;
  const a = document.createElement("a");
  a.href = clip.url; a.download = clip.name;
  document.body.append(a); a.click(); a.remove();
  toast(`Descargando ${clip.name}`);
}
async function shareClip() {
  if (!clip) return;
  try {
    await navigator.share({
      files: [new File([clip.blob], clip.name, { type: clip.type })],
      title: "Cuerdas de luz",
      text: `Toqué cuerdas de luz en el aire ✨ ${SITE_URL}`,
    });
  } catch (e) {
    if (e?.name !== "AbortError") toast("No se pudo compartir. Descargalo y subilo a mano.");
  }
}
ui.clipDownload.addEventListener("click", downloadClip);
ui.clipShare.addEventListener("click", shareClip);
ui.clipDiscard.addEventListener("click", closeClip);
ui.clipClose.addEventListener("click", closeClip);
ui.modal.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return; // el foco no se escapa del diálogo
  const items = [...ui.modal.querySelectorAll("button, video")].filter((el) => !el.hidden && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ───────────────────────── Controles ─────────────────────────
let helpTimer = 0;
function setHelp(on, autoHideMs = 0) {
  clearTimeout(helpTimer);
  ui.help.classList.toggle("show", on);
  ui.helpBtn.classList.toggle("on", on);
  ui.helpBtn.setAttribute("aria-expanded", String(on));
  if (on && autoHideMs) helpTimer = setTimeout(() => setHelp(false), autoHideMs);
}
function setEyes(on) {
  hideEyes = on;
  ui.eyes.classList.toggle("on", on);
  ui.eyes.setAttribute("aria-pressed", String(on));
}
function toggleEyes() {
  if (!useCamera) return;
  if (!hideEyes && faceFailed) { toast("No se pudo cargar el detector de caras."); return; }
  setEyes(!hideEyes);
  if (hideEyes && !faceDetector) toast("Cargando el detector de caras…");
}
function cycleScale() {
  scaleIdx = (scaleIdx + 1) % SCALE_NAMES.length;
  ui.scaleName.textContent = SCALE_NAMES[scaleIdx];
  toast(`Escala: ${SCALE_NAMES[scaleIdx]}`);
}

function start({ noCamera = false } = {}) {
  if (started) return;
  if (noCamera) { useCamera = false; stopCamera(); ui.eyes.hidden = true; }
  started = true; startedAt = performance.now();
  ui.intro.classList.add("hide");
  ui.intro.inert = true;
  document.body.classList.add("live");
  resumeAudio();
  keepScreenOn();
  setHelp(true, 12000);
  if (!useCamera) {
    toast(IS_TOUCH ? "Modo sin cámara: arrastrá el dedo para crear cuerdas y deslizalo a través de ellas para tocarlas."
      : "Modo sin cámara: arrastrá para crear cuerdas y pasá por encima para tocarlas.", { ms: 6000 });
  }
}

ui.retry.addEventListener("click", boot);
ui.noCam.addEventListener("click", () => start({ noCamera: true }));
ui.skip.addEventListener("click", () => start());
ui.rec.addEventListener("click", toggleRecording);
ui.eyes.addEventListener("click", toggleEyes);
ui.undo.addEventListener("click", undoString);
ui.clear.addEventListener("click", clearStrings);
ui.sound.addEventListener("click", toggleMute);
ui.helpBtn.addEventListener("click", () => setHelp(!ui.help.classList.contains("show")));
if (!CAN_RECORD) ui.rec.hidden = true;

// el audio solo puede arrancar después de un toque o una tecla (en iPhone, el toque cuenta al levantar el dedo)
for (const type of ["pointerdown", "touchend", "click"]) addEventListener(type, resumeAudio, { passive: true });
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return; // no pisar Cmd+C, Ctrl+Z, etc.
  resumeAudio();
  if (modalOpen) { if (e.key === "Escape") closeClip(); return; }
  if (e.key === "Escape") { setHelp(false); if (recState === "countdown") toggleRecording(); return; }
  const onControl = e.target instanceof Element && e.target.closest("button, a, video");
  if (e.key === "Enter") { if (!onControl) start(); return; }
  if (!started || e.repeat) return;
  switch (e.key.toLowerCase()) {
    case "r": toggleRecording(); break;
    case "o": toggleEyes(); break;
    case "z": undoString(); break;
    case "c": clearStrings(); break;
    case "m": toggleMute(); break;
    case "s": cycleScale(); break;
    case "h": showHands = !showHands; toast(showHands ? "Manos visibles" : "Manos ocultas", { ms: 1400 }); break;
    case "v": showVideo = !showVideo; toast(showVideo ? "Video visible" : "Video oculto", { ms: 1400 }); break;
    case "?": setHelp(!ui.help.classList.contains("show")); break;
  }
});

// Mouse: arrastrar crea, pasar por encima toca.
// Dedo / lápiz (multitouch): arrastrar crea, salvo que el trazo cruce una cuerda: en ese caso la toca.
let hover = null, hoverT = 0;
const pointerPos = (e) => ({ x: e.clientX, y: e.clientY });
const haptic = () => {
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try { navigator.vibrate?.(8); } catch { /* sin vibración */ }
};
canvas.addEventListener("pointerdown", (e) => {
  if (!started || e.button !== 0) return;
  if (ui.help.classList.contains("show")) setHelp(false); // tocar el lienzo cierra la ayuda
  try { canvas.setPointerCapture(e.pointerId); } catch { /* sin captura: el gesto sigue igual */ }
  const p = pointerPos(e);
  pointers.set(e.pointerId, { start: p, cur: p, last: p, lastT: e.timeStamp, plucked: false, mouse: e.pointerType === "mouse" });
});
canvas.addEventListener("pointermove", (e) => {
  if (!started) return;
  const p = pointerPos(e);
  const ptr = pointers.get(e.pointerId);
  if (ptr) {
    if (!ptr.mouse && pluckAlong(ptr.last, p, e.timeStamp - ptr.lastT)) { ptr.plucked = true; haptic(); }
    ptr.cur = p; ptr.last = p; ptr.lastT = e.timeStamp;
  } else if (e.pointerType === "mouse") {
    if (hover) pluckAlong(hover, p, e.timeStamp - hoverT);
    hover = p; hoverT = e.timeStamp;
  }
});
function endPointer(e) {
  const ptr = pointers.get(e.pointerId);
  if (!ptr) return;
  pointers.delete(e.pointerId);
  const p = pointerPos(e);
  if (e.type === "pointerup" && !ptr.plucked && dist(ptr.start, p) > MIN_STRING_PX) addString(ptr.start, p);
  if (ptr.mouse) { hover = p; hoverT = e.timeStamp; }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !pointers.has(e.pointerId)) hover = null; });

// Que la pantalla no se apague mientras tocás con las manos (sin tocar la pantalla).
let wakeLock = null;
async function keepScreenOn() {
  if (!started || document.hidden || wakeLock || !("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { /* sin soporte o sin permiso: no pasa nada */ }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // en segundo plano el lienzo no se dibuja: cortamos la grabación para no guardar un clip congelado
    if (recState === "countdown") toggleRecording();
    else if (recState === "recording") stopRecording();
  } else {
    if (useCamera && video.paused && (video.srcObject || video.getAttribute("src"))) video.play().catch(() => {});
    keepScreenOn();
  }
});

// ───────────────────────── Arranque ─────────────────────────
function showIntroError(msg, canRetry) {
  if (started) { toast(msg, { ms: 7000 }); return; }
  setStatus(msg, true);
  ui.introActions.hidden = false;
  ui.retry.hidden = !canRetry;
}
let booting = false;
async function boot() {
  if (booting) return;
  booting = true;
  ui.introActions.hidden = true;
  setStatus(TEST_VIDEO ? "Usando un video de prueba…" : "Pidiendo permiso para usar la cámara…");
  const models = loadModels(); // en paralelo: los modelos bajan mientras aceptás el permiso
  models.catch(() => {});
  try {
    try { await startCamera(); }
    catch (e) {
      console.warn(e);
      showIntroError(cameraErrorMessage(e), canRetryCamera(e));
      return;
    }
    setStatus("Cargando el detector de manos (unos 15 MB la primera vez)…");
    try { await models; }
    catch (e) {
      console.error(e);
      showIntroError("No se pudo cargar el detector de manos. Revisá tu conexión y tocá Reintentar.", true);
      return;
    }
    gateReady = true;
    setStatus("Mostrale la mano derecha a la cámara");
  } finally {
    booting = false;
  }
}

// Solo en localhost con ?video=…: deja ver el estado desde la consola para probar sin cámara.
if (TEST_VIDEO) window.__cuerdas = { processHands, hands, strings, drops, IS_TOUCH, getBridge: () => bridge, getDetectCost: () => detectCost };

updateRecUI();
updateSoundUI();
boot();
requestAnimationFrame(frame);
