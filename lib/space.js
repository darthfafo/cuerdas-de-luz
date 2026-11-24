// El espacio 3D de las cuerdas. Unidades: metros. La cámara está en el origen;
// x hacia la derecha (imagen espejada), y hacia abajo, z hacia adentro de la pantalla.
import { clamp } from "./gestures.js?v=20261124b";

export const Z_DEFAULT = 0.6;              // profundidad del mouse, del dedo y de manos sin medir
export const Z_MIN = 0.18, Z_MAX = 2.5;
const FOCAL = 0.8;                         // cámara web típica (~64° de ancho): focal = 0,8 × lado largo de la imagen
const PIVOT_Z = 0.75;                      // centro de giro de la vista 3D

export const add3 = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
export const lerp3 = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
export const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Píxeles por metro de una mano: el mejor ajuste entre sus 21 puntos en pantalla y los 21 puntos 3D.
// A diferencia del tamaño aparente, no cambia cuando la mano se inclina o se pone de perfil.
export function handScale(p, w) {
  if (!w) return 0;
  let px = 0, py = 0, wx = 0, wy = 0;
  for (let i = 0; i < 21; i++) { px += p[i].x; py += p[i].y; wx += w[i].x; wy += w[i].y; }
  px /= 21; py /= 21; wx /= 21; wy /= 21;
  let num = 0, den = 0;
  for (let i = 0; i < 21; i++) {
    const ax = w[i].x - wx, ay = w[i].y - wy;
    num += (p[i].x - px) * ax + (p[i].y - py) * ay;
    den += ax * ax + ay * ay;
  }
  return den > 1e-9 ? num / den : 0;
}

export function createSpace() {
  let W = 1, H = 1, f = 1;
  // amt: 0 = como la ve la cámara, 1 = vista girada
  const view = { on: false, amt: 0, yaw: 0, pitch: 0, dragYaw: 0, dragPitch: 0 };

  return {
    view,
    // imgW × imgH: tamaño con el que se ve la imagen de la cámara en pantalla (o la ventana, si no hay cámara)
    setSize(w, h, imgW, imgH) { W = w; H = h; f = FOCAL * Math.max(imgW, imgH); },
    depthOf(p, w) { const s = handScale(p, w); return s > 1 ? clamp(f / s, Z_MIN, Z_MAX) : null; },

    unproject: (x, y, z) => ({ x: ((x - W / 2) * z) / f, y: ((y - H / 2) * z) / f, z }),
    // k: píxeles por metro a esa profundidad
    projectCam(p) { const z = Math.max(0.05, p.z), k = f / z; return { x: W / 2 + p.x * k, y: H / 2 + p.y * k, k, z }; },
    project(p) {
      if (view.amt < 0.001) return this.projectCam(p);
      const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
      const dz = p.z - PIVOT_Z;
      const x = p.x * cy + dz * sy, z1 = -p.x * sy + dz * cy;
      return this.projectCam({ x, y: p.y * cp - z1 * sp, z: p.y * sp + z1 * cp + PIVOT_Z + 0.35 * view.amt });
    },

    // La vista 3D se mece sola; si la arrastrás, gira con vos.
    updateView(now, k) {
      view.amt += ((view.on ? 1 : 0) - view.amt) * (1 - Math.pow(0.9, k));
      if (!view.on && view.amt < 0.002) view.amt = 0;
      view.yaw = view.amt * (0.5 * Math.sin(now / 2600) + view.dragYaw);
      view.pitch = view.amt * (0.22 + 0.06 * Math.sin(now / 3700) + view.dragPitch);
    },
    focal: () => f,
  };
}

// Cruce en pantalla → fracción del largo 3D (en perspectiva, lo que es lineal en pantalla es 1/z).
export const screenToU = (t, za, zb) => (t / zb) / ((1 - t) / za + t / zb);

// Contorno aproximado de la mano: la palma y cada dedo como una cápsula, todo con el mismo sentido de giro.
export function handSilhouette(p) {
  const size = Math.hypot(p[0].x - p[9].x, p[0].y - p[9].y);
  const path = new Path2D();
  const poly = (pts) => {
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a.x * b.y - b.x * a.y; }
    if (area < 0) pts = [...pts].reverse();
    path.moveTo(pts[0].x, pts[0].y);
    for (const q of pts.slice(1)) path.lineTo(q.x, q.y);
    path.closePath();
  };
  const circle = (q, r) => { path.moveTo(q.x + r, q.y); path.arc(q.x, q.y, r, 0, Math.PI * 2); };
  const bone = (i, j, r) => {
    const a = p[i], b = p[j], l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / l) * r, ny = ((b.x - a.x) / l) * r;
    poly([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]);
    circle(a, r); circle(b, r);
  };
  poly([0, 1, 5, 9, 13, 17].map((i) => p[i]));
  for (const [i, j] of [[0, 1], [1, 2], [0, 5], [0, 17], [5, 9], [9, 13], [13, 17]]) bone(i, j, size * 0.16);
  for (const [i, j] of [[2, 3], [3, 4]]) bone(i, j, size * 0.12);
  for (const b of [5, 9, 13, 17]) for (let i = b; i < b + 3; i++) bone(i, i + 1, size * (b === 17 ? 0.09 : 0.11));
  return path;
}
