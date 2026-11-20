# ADR 0002: Composición no destructiva por clip (ClipLayout) en coordenadas normalizadas

- **Estado:** Aceptada
- **Fecha:** 2026-11-19

## Contexto
La detección automática de la facecam a veces elegía una región equivocada o recortaba la cámara, y el usuario no tenía forma cómoda de corregirlo. El layout sólo se guardaba como `layout` + `camRect`, con un único formato 1080×1920.

## Decisión
1. Cada clip tiene una `composition` (`ClipLayout`, `src/shared/composition.ts`): plantilla, `facecamRect`, `facecamCrop` (pan y zoom), `facecamPosition`, `overlayRect` (caja en la salida), `gameplayCrop`, `outputAspectRatio` (9:16, 1:1, 16:9), `confidence`, `manualOverride`, `source` y `needsReview`.
2. **Todo en coordenadas normalizadas 0–1.** El render (`layoutFilter`) las traduce a píxeles pares para la resolución de origen y de salida concretas. Nunca se guardan píxeles como fuente de verdad.
3. **Compatibilidad.** Los clips antiguos sólo tienen `layout`/`camRect`: `compositionOf()` deriva la composición, y `layout`/`camRect` se mantienen sincronizados al guardar.
4. **Detección multi-ventana.** Se analizan 12 fotogramas, por separado en tres ventanas y en conjunto. `combineDetections()` elige la región que más se repite (IoU ≥ 0,5) y une los rectángulos coincidentes, para no cortar la cámara. Multiplica la confianza por la consistencia: una cara que aparece en un solo momento del gameplay no es una facecam.
5. **Fallback seguro.** Con poca confianza se usa «Gameplay completo» (sin recortes agresivos) y se marca «Revisar composición».
6. **Render aislado.** Cambiar la composición sólo re-renderiza ese clip, con el vídeo, la transcripción y los fotogramas ya existentes. El MP4 anterior se sustituye con un `rename` atómico cuando el nuevo termina. Si falla, se conserva el anterior y se muestra el error.
7. La huella de composición y subtítulos se guarda en `rendered`, así «cambios sin renderizar» refleja la realidad (deshacer los cambios lo limpia).

## Consecuencias
- El editor (modal «Editar clip») permite plantillas, arrastrar y redimensionar la caja de la cámara (ratón y teclado), zoom, posición, formato y guías de área segura, con vista previa de un fotograma.
- `split_horizontal` y `split_vertical` asumen que el contenido se reparte en dos mitades del origen; para otros casos está «Personalizado».
- La detección sigue siendo heurística (bordes persistentes): no reconoce caras. La palabra final la tiene el usuario.

## Revisión (2026-11-20): cámara del original frente a cámara del resultado
**Problema.** El recuadro rosa marcaba bien la cámara en el original, pero el render la sacaba mal recortada o ampliada. Causa: `camChain` no recortaba la selección, sino que la **ampliaba al aspecto del hueco de destino** (`fitAspect`) alrededor de su centro. En «Facecam arriba/abajo» el hueco es 1080×704 en 9:16, pero 1920×396 en 16:9 (aspecto 4,85). Así, una cámara 4:3 se convertía en una franja de 1455×300 px de gameplay con la cámara en un lado, y en 9:16 entraba gameplay a ambos lados. Además, la caja de salida de la vista previa perdía su aspecto en 1:1/16:9 (`max-width`), así que el recuadro «en el vídeo final» no coincidía con el resultado. Y las guías de área segura salían también en las plantillas apiladas, donde no se pueden editar.

**Decisión.**
1. Dos conceptos con nombres imposibles de confundir: `sourceFacecamRect` (dónde está la cámara en el **vídeo original**, lo único que se recorta de la fuente) y `outputFacecamRect` (dónde aparece en el **resultado**, sólo «flotante» y «personalizado», sin efecto sobre el recorte). En `LayoutInput` se llaman `sourceCam` y `outputCam`. Los trabajos guardados con `facecamRect`/`overlayRect` se leen sin migración destructiva (`compositionOf`).
2. `camChain` recorta **exactamente** la selección (en píxeles pares, dentro del fotograma), le aplica el zoom/encuadre del usuario dentro de ella y la encaja entera (`scale=…:force_original_aspect_ratio=decrease` + `pad` negro). Nunca recorta la cámara, nunca la deforma y nunca añade gameplay de alrededor. Con la misma proporción (±2 %) se escala directamente.
3. La caja flotante por defecto usa la proporción real de la cámara elegida, así que no aparecen bandas.
4. Vista previa y render usan el mismo `layoutInputFor` → `layoutFilter`.
5. Detección: además de la consistencia entre ventanas, `facecamShape` penaliza regiones en el centro (p. ej. una cara del gameplay), con proporción poco habitual o demasiado grandes. Los bordes se afinan y se toma el marco **exterior** si hay un borde interior (overlays con marco), con 1 px de margen hacia fuera. Cada clip guarda un diagnóstico (`visual.diagnostic`: muestras, ventanas, consistencia, rectángulo y motivo). Sin confianza suficiente, el clip usa «Sin facecam: sólo gameplay» y muestra «No se pudo confirmar una facecam. Ajústala manualmente.»
6. Editor: «1 · Cámara en el vídeo original» (un solo recuadro, mantener proporción, 16:9, 4:3, restablecer y diagnóstico) y «2 · Resultado». Las guías de área segura sólo aparecen con cámara flotante o personalizada. «Vídeo entero difuminado» y las divisiones horizontal/vertical pasan a «Herramientas avanzadas».
7. Windows: si el MP4 anterior está abierto en un reproductor, no se puede sustituir. Tras unos reintentos, el render nuevo se guarda con otro nombre (`…_v<id>.mp4`) en vez de fallar, y el anterior se borra cuando se pueda.

**Pruebas.** `tests/facecam.ffmpeg.test.ts` usa FFmpeg real con un vídeo sintético: gameplay en blanco y negro y cámara magenta con un cuadrado verde en cada esquina. Comprueba las cuatro plantillas en 9:16, 1:1 y 16:9: las cuatro esquinas visibles, la proporción original y la posición en su hueco. También comprueba la detección con y sin cámara.
