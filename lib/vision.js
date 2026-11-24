// Modelos de MediaPipe (manos y, opcionalmente, caras). Todo corre en el navegador.

export const MP_VERSION = "0.10.14";
export const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
export const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
export const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

let attempts = 0;

// Devuelve { hands, face }: hands es el detector de manos; face, una promesa del detector de caras (o null).
export async function loadVision({ numHands = 2, face = false } = {}) {
  // si el CDN falló, el navegador recuerda el error del módulo: en el reintento cambiamos la URL
  const bust = attempts++ ? `?retry=${attempts}` : "";
  const { FilesetResolver, HandLandmarker, FaceDetector } = await import(`${MP_BASE}/vision_bundle.mjs${bust}`);
  const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const create = async (Task, options) => {
    const withDelegate = (delegate) => ({ ...options, baseOptions: { ...options.baseOptions, delegate } });
    try { return await Task.createFromOptions(fileset, withDelegate("GPU")); }
    catch (err) { console.warn("GPU no disponible, sigo con CPU.", err); return Task.createFromOptions(fileset, withDelegate("CPU")); }
  };
  const hands = await create(HandLandmarker, {
    baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: "VIDEO", numHands,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  const faceDetector = face
    ? create(FaceDetector, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: "VIDEO", minDetectionConfidence: 0.5 })
    : null;
  return { hands, face: faceDetector };
}
