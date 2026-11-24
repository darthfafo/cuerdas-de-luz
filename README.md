# Cuerdas de luz

Instrumento de cuerdas en el aire, controlado con las manos a través de la cámara web. Funciona en el navegador.

**Demo:** https://darthfafo.github.io/cuerdas-de-luz/

## Cómo se usa

1. Permite el acceso a la cámara.
2. Haz un pulgar arriba 👍 con la mano derecha para empezar.
3. Haz una pinza (pulgar + índice) con cada mano: entre ellas aparece una cuerda. Suelta y queda tendida.
4. Pasa la punta del índice a través de una cuerda para tocarla. Las cuerdas largas suenan graves y las cortas agudas.

Botones: **Ocultar ojos** (barra negra sobre los ojos) y **Limpiar cuerdas**.
Teclas: `Z` deshacer · `C` borrar · `H` manos · `S` escala · `V` video.

## Tecnología

- [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker): detección de manos y caras
- Canvas 2D para el dibujo y Web Audio (Karplus-Strong) para el sonido de cuerda pulsada
- Un solo `index.html`, sin compilación

## Ejecutar en local

```bash
python3 -m http.server 8766
```

Luego abre http://localhost:8766. La cámara solo funciona en `localhost` o con HTTPS.
