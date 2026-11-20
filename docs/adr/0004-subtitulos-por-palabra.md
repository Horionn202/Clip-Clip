# ADR 0004: Subtítulos por palabra, idioma forzado y edición manual

- **Estado:** Aceptada
- **Fecha:** 2026-11-19

## Contexto
Había palabras mal reconocidas, frases que aparecían antes o después de decirse y palabras de instantes distintos mezcladas. Por ejemplo, «Dios» seguido de texto del siguiente instante. La causa era doble: el idioma se autodetectaba por defecto, y los subtítulos se agrupaban de 3 en 3 palabras sin mirar los silencios.

## Decisión
1. **Idioma forzado.** `whisperLanguage` vale `'es'` por defecto y se pasa siempre a Whisper como `--language`. La autodetección es la opción explícita `'auto'`. Los ajustes antiguos vacíos se migran a `'es'`. El trabajo guarda el idioma pedido y el detectado.
2. **Cues por palabra** (`src/shared/cues.ts`):
   - 2–5 palabras por cue, ≤ 28 caracteres y ≤ 2,6 s.
   - Corte por silencio (≥ 0,55 s), por puntuación fuerte y por coma cuando hay el mínimo de palabras.
   - Cada cue empieza en el timestamp de su primera palabra y nunca invade el siguiente.
   - Las palabras se sanean: orden, sin solapes ni tiempos imposibles.
   - Una palabra que empezó antes del clip no se arrastra.
3. **Sin LLM sobre lo dicho.** La única normalización es de espacios, espacio antes de puntuación y mayúscula tras punto. Nunca cambia, añade ni quita palabras. La transcripción original se conserva: `transcript.json` y, al reprocesar, `transcript.orig.json` y `transcript.prev.json`.
4. **Edición manual.** Pestaña «Subtítulos» del editor: tiempos y texto, dividir, unir, quitar, reproducir desde un cue, vista previa en vivo y «Restablecer versión automática». Se guardan en `clip.subtitleCues` (relativos al clip) y sólo exigen re-renderizar ese clip.
5. **Reprocesar sólo transcripción.** Reutiliza `audio.wav` o lo extrae del vídeo original. Nunca se ejecuta con otro trabajo o retranscripción en curso (una inferencia pesada a la vez). Sólo sustituye la transcripción si la nueva es válida.
6. **Área segura.** El margen inferior de los subtítulos sale de `SAFE_AREA`, por encima de los botones de TikTok, Shorts y Reels, y se escala al formato de salida.

## Consecuencias
- Los clips ya renderizados no cambian hasta volver a renderizarlos.
- La calidad depende del modelo (Rápido, Equilibrado, Preciso en Configuración → Modelos), que ya se elige según la VRAM disponible.

## Revisión (2026-11-20): karaoke por palabra
1. Estilo configurable (Configuración → Estilo de subtítulo): **Estándar** o **Karaoke por palabra** (por defecto), con color activo (`#3B82F6`) y tamaño de fuente.
2. Karaoke: cada cue (2–5 palabras) se ve **entero** desde su inicio. Hay un evento ASS por tramo de tiempo en el que **sólo** la palabra que se está diciendo lleva `\1c` azul; las anteriores vuelven a blanco y, en los silencios entre palabras, ninguna está activa. Se mantienen el borde y la sombra del estilo.
3. Los cues guardan los tiempos de Whisper de cada palabra (`Cue.words`). Si se edita el texto o los tiempos, se reparten provisionalmente según la longitud de cada palabra, y el editor avisa de que pueden necesitar ajuste. Dividir y unir conservan los tiempos reales.
4. Sin tiempos por palabra (transcripción sólo con segmentos), los subtítulos salen de los segmentos con el estilo estándar y el editor dice que no hay karaoke disponible.
5. La vista previa del editor usa `wordTimings` y `activeWordIndex`, la misma lógica que el ASS. Mientras se reproduce, sigue al vídeo fotograma a fotograma.
6. «Reprocesar sólo transcripción» muestra el modelo, el idioma pedido y el detectado, GPU/CPU y si hay tiempos por palabra. Ofrece **modo preciso**: faster-whisper con `beam_size=8`, `best_of=5`, `temperature=0`, sin `condition_on_previous_text` y con `vad_filter`; openai-whisper con `--beam_size 5 --best_of 5 --temperature 0 --condition_on_previous_text False`. El español sigue siendo el idioma por defecto y se envía explícitamente (`es`).
