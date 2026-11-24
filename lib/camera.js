// Cámara: abrirla, cerrarla, mensajes de error y mapeo a la pantalla.
// Lo usan la app de cuerdas y el juego.

// Celulares y tablets (puntero táctil)
export const IS_TOUCH = matchMedia("(pointer: coarse)").matches;

// Solo en localhost: ?video=ruta/al/clip.mp4 usa un video en vez de la cámara (para probar sin webcam).
export function testVideoUrl() {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return null;
  const v = new URLSearchParams(location.search).get("video");
  if (!v) return null;
  try { const u = new URL(v, location.href); return u.origin === location.origin ? u.href : null; } catch { return null; }
}

const namedError = (name) => Object.assign(new Error(name), { name });

// Abre la cámara frontal (o el video de prueba) en el <video>. Devuelve el stream (null si es video de prueba).
export async function openCamera(video, { testVideo = null, onEnded = null } = {}) {
  if (testVideo) {
    video.srcObject = null; video.src = testVideo; video.loop = true; video.muted = true;
    await video.play();
    return null;
  }
  if (!window.isSecureContext) throw namedError("InsecureContextError");
  if (!navigator.mediaDevices?.getUserMedia) throw namedError("UnsupportedError");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // en el celu, la resolución por defecto de la cámara frontal alcanza y gira bien con el teléfono
      video: IS_TOUCH
        ? { facingMode: "user", frameRate: { ideal: 30, max: 30 } }
        : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
  } catch (e) {
    if (e.name !== "OverconstrainedError") throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  }
  if (onEnded) stream.getVideoTracks()[0]?.addEventListener("ended", onEnded);
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function closeCamera(video, stream) {
  if (stream) for (const t of stream.getTracks()) t.stop();
  video.srcObject = null;
  if (video.getAttribute("src")) { video.pause(); video.removeAttribute("src"); video.load(); }
}

export function cameraErrorMessage(e) {
  switch (e?.name) {
    case "InsecureContextError": return "La cámara solo funciona con https:// o en localhost.";
    case "UnsupportedError": return "Este navegador no permite usar la cámara. Probá con Chrome, Edge, Safari o Firefox actualizados.";
    case "NotAllowedError": case "SecurityError": case "PermissionDeniedError":
      return "No hay permiso para usar la cámara. Habilitalo desde el candado de la barra de direcciones y tocá Reintentar.";
    case "NotFoundError": case "DevicesNotFoundError": case "OverconstrainedError":
      return "No encontré ninguna cámara conectada.";
    case "NotReadableError": case "TrackStartError": case "AbortError":
      return "La cámara está ocupada por otra app (Zoom, Meet…). Cerrala y tocá Reintentar.";
    default: return "No se pudo abrir la cámara. Tocá Reintentar.";
  }
}
export const canRetryCamera = (e) => !["InsecureContextError", "UnsupportedError"].includes(e?.name);

// Video → pantalla: espejado y recortado para cubrir toda la ventana.
export function coverMap(video, W, H) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return null;
  const sc = Math.max(W / vw, H / vh);
  const dw = vw * sc, dh = vh * sc;
  return { ox: (W - dw) / 2, oy: (H - dh) / 2, dw, dh };
}
