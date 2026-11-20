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
