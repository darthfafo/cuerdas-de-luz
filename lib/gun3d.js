// La pistola de agua en 3D (three.js) y utilidades de escena compartidas por la app y el juego.
// three.js se baja recién cuando hace falta (nadie paga el peso si no aparece la pistola).

export const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js";

export const GUN_STYLES = [
  { name: "agua", body: ["#8ff6ff", "#1aa7ff"], grip: ["#ffb347", "#ff7a1a"], accent: "#ffd93b", nozzle: "#ff7a1a", rainbow: false },
  { name: "fantasía", body: ["#f3b4ff", "#8a4dff"], grip: ["#ff9ad9", "#e0409a"], accent: "#ffe27a", nozzle: "#ffe27a", rainbow: true },
];
export const randomGunStyle = () => GUN_STYLES[Math.floor(Math.random() * GUN_STYLES.length)];

export const easeOutBack = (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

let threePromise = null;
export function loadThree() {
  threePromise ||= import(THREE_URL).catch((e) => { threePromise = null; throw e; });
  return threePromise;
}

// Reflejos de estudio armados a mano (unas luces en una caja): dan el brillo de plástico y metal
// sin bajar ningún archivo de entorno.
export function makeEnvironment(T, renderer) {
  const env = new T.Scene();
  env.add(new T.Mesh(new T.BoxGeometry(10, 10, 10), new T.MeshBasicMaterial({ color: 0x14161c, side: T.BackSide })));
  const panel = (w, h, color, power, x, y, z, rx = 0, ry = 0) => {
    const mat = new T.MeshBasicMaterial({ color: new T.Color(color).multiplyScalar(power), side: T.DoubleSide });
    const m = new T.Mesh(new T.PlaneGeometry(w, h), mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0); env.add(m);
  };
  panel(6, 3, 0xffffff, 4, 0, 4.9, 0, Math.PI / 2);        // techo
  panel(3, 4, 0xffe2c0, 2.5, -4.9, 1, 0, 0, Math.PI / 2);  // izquierda, cálida
  panel(3, 4, 0xbfe0ff, 2.5, 4.9, 0, -1, 0, -Math.PI / 2); // derecha, fría
  panel(4, 2, 0xffffff, 2, 0, 1.2, 4.9, 0, Math.PI);       // frente
  const pmrem = new T.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose();
  disposeObject(env);
  return texture;
}

export function disposeObject(obj) {
  obj.parent?.remove(obj);
  obj.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) m.dispose();
  });
}

// Orienta un objeto con la pose de la mano (f: caño, d: palma) dada en el sistema de la pantalla
// (x derecha, y abajo, z hacia adentro). Devuelve la dirección del caño en el sistema de three.js.
export function orientGun(T, obj, f, d) {
  const F = new T.Vector3(f.x, -f.y, -f.z).normalize();
  const D = new T.Vector3(d.x, -d.y, -d.z);
  D.addScaledVector(F, -D.dot(F)).normalize();
  const Y = D.clone().negate(), Z = new T.Vector3().crossVectors(F, Y);
  obj.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(F, Y, Z));
  return F;
}

// Modelo armado con piezas: x hacia adelante (caño), y hacia arriba (tanque), empuñadura hacia abajo.
// Unidad = tamaño de la mano. La boquilla queda en (1.6, 0, 0).
export function buildGunModel(T, S) {
  const group = new T.Group();
  const plastic = (color) => new T.MeshPhysicalMaterial({ color, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12 });
  const bodyMat = plastic(new T.Color(S.body[0]).lerp(new T.Color(S.body[1]), 0.55));
  const gripMat = plastic(new T.Color(S.grip[0]).lerp(new T.Color(S.grip[1]), 0.5));
  const accentMat = plastic(S.accent);
  const nozzleMat = plastic(S.nozzle);
  const add = (geo, mat, x, y, z = 0) => { const mesh = new T.Mesh(geo, mat); mesh.position.set(x, y, z); group.add(mesh); return mesh; };
  const alongX = (mesh) => { mesh.rotation.z = -Math.PI / 2; return mesh; };

  alongX(add(new T.CapsuleGeometry(0.19, 1.2, 8, 24), bodyMat, 0.45, 0));               // cuerpo
  alongX(add(new T.CylinderGeometry(0.2, 0.2, 0.1, 28), accentMat, 0.85, 0));             // franja
  alongX(add(new T.CylinderGeometry(0.08, 0.1, 0.32, 20), nozzleMat, 1.36, 0));           // caño
  add(new T.TorusGeometry(0.075, 0.025, 10, 24), accentMat, 1.52, 0).rotation.y = Math.PI / 2; // punta
  const grip = add(new T.CapsuleGeometry(0.15, 0.55, 8, 16), gripMat, -0.12, -0.5);       // empuñadura
  grip.rotation.z = -0.22; grip.scale.z = 0.85;
  add(new T.TorusGeometry(0.16, 0.03, 10, 24, Math.PI), gripMat, 0.32, -0.17).rotation.z = Math.PI; // guardamonte
  const trigGeo = new T.BoxGeometry(0.05, 0.2, 0.08); trigGeo.translate(0, -0.1, 0);
  const trigger = add(trigGeo, accentMat, 0.28, -0.16);                                   // gatillo
  // tanque transparente con agua adentro
  const water = add(new T.CylinderGeometry(0.16, 0.16, 0.4, 24), new T.MeshStandardMaterial({
    color: S.rainbow ? 0xc58bff : 0x3aa8ff, emissive: S.rainbow ? 0x5a1a8a : 0x0a3a6a, emissiveIntensity: 0.5,
    roughness: 0.2, transparent: true, opacity: 0.85,
  }), 0.42, 0.3);
  water.renderOrder = 1;
  const tank = add(new T.CapsuleGeometry(0.2, 0.28, 8, 24), new T.MeshPhysicalMaterial({
    color: 0xe6f8ff, roughness: 0.05, clearcoat: 1, transparent: true, opacity: 0.3, depthWrite: false,
  }), 0.42, 0.42);
  tank.renderOrder = 2;
  add(new T.CylinderGeometry(0.09, 0.1, 0.08, 20), accentMat, 0.42, 0.8);                 // tapa
  const glow = add(new T.SphereGeometry(0.11, 16, 12), new T.MeshBasicMaterial({
    color: S.rainbow ? 0xffb0f0 : 0xb0e8ff, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending,
  }), 1.62, 0);
  let gem = null;
  if (S.rainbow) {
    // fantasía: estrellas a los costados y una gema que gira atrás
    const starGeo = new T.ExtrudeGeometry(starShape(T, 0.095, 0.04), { depth: 0.02, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 2 });
    add(starGeo, accentMat, 0.22, 0, 0.18);
    add(starGeo, accentMat, 0.22, 0, -0.18).rotation.y = Math.PI;
    gem = add(new T.IcosahedronGeometry(0.1), new T.MeshStandardMaterial({ color: 0xffe27a, emissive: 0xff5fcf, emissiveIntensity: 0.9, roughness: 0.15, flatShading: true }), -0.42, 0.05);
  }
  return { group, trigger, water, glow, gem };
}

// Animaciones de la pistola: gatillo que sigue al dedo (bend en radianes), nivel de agua (0–1), brillo al disparar.
export function animateGun(model, { bend = 0, level = 0.82, firing = false, now = 0 }) {
  model.trigger.rotation.z = 0.12 - 0.6 * Math.min(1, Math.max(0, (bend - 0.2) / 0.9));
  const l = Math.max(0.04, level) + Math.sin(now / 260) * 0.03;
  model.water.scale.y = l; model.water.position.y = 0.12 + 0.2 * l;
  model.glow.material.opacity = firing ? 0.5 + Math.random() * 0.3 : 0;
  if (model.gem) model.gem.rotation.set(now / 900, now / 600, 0);
}

export function starShape(T, outer, inner) {
  const shape = new T.Shape();
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? inner : outer;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.closePath();
  return shape;
}
