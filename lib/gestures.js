// Gestos de la mano y geometría 3D. Funciones puras: reciben los 21 puntos de MediaPipe
// en pantalla (p, en píxeles) y, si están, los puntos 3D en metros (w: x derecha, y abajo, z hacia adentro).

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v) => clamp(v, 0, 1);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Vectores 3D (sirven igual para puntos 2D: z = 0)
export const sub3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
export const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const len3 = (a) => Math.hypot(a.x, a.y, a.z) || 1e-9;
export const nrm3 = (a) => { const l = len3(a); return { x: a.x / l, y: a.y / l, z: a.z / l }; };
export const cross3 = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const angle3 = (a, b) => Math.acos(clamp(dot3(a, b) / (len3(a) * len3(b)), -1, 1));
const angle2 = (a, b) => angle3({ ...a, z: 0 }, { ...b, z: 0 });

export const palmCenter = (p) => ({ x: (p[0].x + p[9].x + p[13].x + p[17].x) / 4, y: (p[0].y + p[9].y + p[13].y + p[17].y) / 4 });

// Pulgar arriba: pulgar estirado hacia arriba, más alto que el resto, y los otros dedos cerrados.
export function isThumbsUp(p) {
  const size = dist(p[0], p[9]);
  const tv = { x: p[4].x - p[2].x, y: p[4].y - p[2].y };
  const tl = Math.hypot(tv.x, tv.y);
  if (tl < size * 0.45 || tv.y > -0.7 * tl) return false;
  for (const i of [8, 12, 16, 20]) if (p[i].y < p[4].y + size * 0.15) return false;
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) if (dist(p[tip], p[0]) > dist(p[pip], p[0]) * 1.1) return false;
  return true;
}

// Pistolita: índice estirado y derecho; mayor, anular y meñique cerrados.
export function isGunShape(p) {
  if (dist(p[8], p[0]) < dist(p[6], p[0]) * 1.15) return false;
  const a = { x: p[6].x - p[5].x, y: p[6].y - p[5].y }, b = { x: p[8].x - p[6].x, y: p[8].y - p[6].y };
  if (angle2(a, b) > 0.6) return false;
  for (const [tip, pip] of [[12, 10], [16, 14], [20, 18]]) if (dist(p[tip], p[0]) > dist(p[pip], p[0]) * 1.1) return false;
  return true;
}

// Pulgar "amartillado": bien separado de la línea del índice y del lado contrario a la palma.
// (Al señalar para tocar cuerdas, el pulgar queda apoyado del lado de la palma: eso no cuenta.)
export function isThumbCocked(p, size) {
  const fl = dist(p[5], p[8]) || 1;
  const fx = (p[8].x - p[5].x) / fl, fy = (p[8].y - p[5].y) / fl;
  const side = (q) => (q.x - p[5].x) * -fy + (q.y - p[5].y) * fx; // distancia con signo a la línea del índice
  const thumb = side(p[4]), palm = side(palmCenter(p));
  return thumb * palm < 0 && Math.abs(thumb) > size * 0.35;
}

// Agarre: mayor, anular y meñique cerrados (el índice puede estar estirado o apretando el gatillo).
// Con los puntos 3D no importa hacia dónde esté girada la mano.
export function isGripShape(p, w) {
  const q = w || p;
  return [[12, 10], [16, 14], [20, 18]].every(([tip, pip]) => len3(sub3(q[tip], q[0])) < len3(sub3(q[pip], q[0])) * 1.1);
}

// Puño: los cuatro dedos cerrados (el pulgar no importa). El índice tiene que estar bien plegado sobre la
// palma: medido en video, en una pinza su punta queda a más de 1,85 falanges del nudillo.
export function isFist(p, w) {
  const q = w || p, d = (a, b) => len3(sub3(q[a], q[b]));
  return [[8, 6], [12, 10], [16, 14], [20, 18]].every(([tip, pip]) => d(tip, 0) < d(pip, 0)) && d(8, 5) < d(6, 5) * 1.75;
}

// Cuánto está doblado el índice (radianes): 0 = estirado, ~1.5 = cerrado del todo.
export const indexBend = (p, w) => { const q = w || p; return angle3(sub3(q[6], q[5]), sub3(q[8], q[7])); };

// Pose 3D de la "pistola" en la mano:
//   f: hacia dónde apunta el caño; d: hacia dónde queda la palma (la empuñadura); u: tamaño de la mano en píxeles.
// La dirección del índice se guarda en el sistema de la palma (cal), así al cerrar el índice para disparar
// la pistola sigue apuntando derecho. Con calibrate = true, cal se va alineando con el índice estirado.
export function handPose3D(p, w, cal = null, calibrate = true) {
  const a = nrm3(sub3(w[5], w[0]));
  const n = nrm3(cross3(a, sub3(w[17], w[0])));
  const b = cross3(n, a);
  const finger = nrm3(sub3(w[8], w[5]));
  const local = { x: dot3(finger, a), y: dot3(finger, b), z: dot3(finger, n) };
  let c = local;
  if (cal) c = calibrate ? nrm3({ x: cal.x + (local.x - cal.x) * 0.25, y: cal.y + (local.y - cal.y) * 0.25, z: cal.z + (local.z - cal.z) * 0.25 }) : cal;
  const f = nrm3({ x: a.x * c.x + b.x * c.y + n.x * c.z, y: a.y * c.x + b.y * c.y + n.y * c.z, z: a.z * c.x + b.z * c.y + n.z * c.z });
  const palm = { x: (w[0].x + w[9].x + w[13].x + w[17].x) / 4, y: (w[0].y + w[9].y + w[13].y + w[17].y) / 4, z: (w[0].z + w[9].z + w[13].z + w[17].z) / 4 };
  let d = sub3(palm, w[5]);
  const along = dot3(d, f);
  d = nrm3({ x: d.x - along * f.x, y: d.y - along * f.y, z: d.z - along * f.z });
  // tamaño real de la mano en píxeles: píxeles por metro (con huesos de la palma) × largo de la mano en 3D
  let px = 0, m = 0;
  for (const [i, j] of [[0, 5], [0, 17], [5, 17], [0, 9]]) { px += dist(p[i], p[j]); m += Math.hypot(w[i].x - w[j].x, w[i].y - w[j].y); }
  const u = m > 1e-4 ? (px / m) * len3(sub3(w[9], w[0])) : dist(p[0], p[9]);
  return { f, d, u, ox: p[5].x, oy: p[5].y, cal: c };
}
