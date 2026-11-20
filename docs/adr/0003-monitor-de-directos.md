# ADR 0003: Monitor de directos por grabación segmentada hacia adelante

- **Estado:** Aceptada
- **Fecha:** 2026-11-19

## Contexto
Se pide generar clips mientras dura un directo de YouTube (propio o autorizado), procesando sólo material nuevo, sin descargar el directo completo repetidamente, sin saturar GPU, RAM ni disco, y con posibilidad de pausar y reanudar.

## Decisión
1. **Consulta de estado** con `yt-dlp -J` (`live_status`). Un canal se consulta en su pestaña `/live`. Sin directo se espera y se vuelve a mirar cada `pollSec`.
2. **Grabación hacia adelante.** `yt-dlp -g` obtiene el HLS y FFmpeg lo graba sin recodificar (`-c copy -f segment -segment_time blockSec`) en `live/<id>/seg_NNNNN.ts`. Nunca se descarga el directo entero ni se repite una ventana.
3. **Bloques.** Un segmento está completo cuando existe el siguiente o la grabación terminó. Cada bloque son los últimos `overlapSec` (3–5 s) del segmento anterior más el actual (concat sin recodificar). Se procesa como un **trabajo normal** con `localSource`: misma transcripción, análisis, selección y render, con la misma cola.
4. **Deduplicación** en tiempo absoluto de la grabación. Un clip es duplicado si comparte ≥ 50 % del más corto o ≥ 3 s del solape con otro, o si tiene el mismo título normalizado. Los duplicados se quitan del trabajo (nunca se quitan clips exportados).
5. **Límites de consumo.** Una grabación por monitor, un bloque en proceso por monitor, y la cola global (`maxConcurrentJobs`) serializa transcripción y render. Nunca hay dos inferencias pesadas a la vez en la GPU.
6. **Persistencia y reanudación.** `data/monitors.json` guarda el estado, `recordedSec`, `lastProcessedSec`, `nextSegment`, los bloques con su huella y los huecos. Al abrir la app, un monitor activo pasa a «Pausado» y anota el hueco. Al reanudar, primero se procesan los segmentos ya grabados y luego se sigue desde el momento actual.
7. **Fin del directo.** Si la grabación termina y `yt-dlp` dice que el directo ya no está activo, se procesa lo pendiente, se limpia y se marca «Finalizado» con un resumen. Si sigue en directo (corte de red o enlace HLS caducado), se reconecta y se anota el hueco.
8. **Temporales.** Tras procesar un bloque se borran su archivo y los segmentos anteriores. Se conserva el último, que hace falta para el solape, salvo que el usuario elija conservar los segmentos. Los clips y los trabajos se conservan.

9. **Robustez (revisión previa al merge).**
   - **Comprobación previa:** antes de grabar se comprueba que estén yt-dlp, FFmpeg y FFprobe, y que el modelo de Whisper esté descargado (los bloques no descargan modelos). Si falta algo, el monitor pasa a «Error» con el motivo y se puede reanudar.
   - **Duración del segmento:** si FFprobe no puede medir un segmento, el bloque queda en «Error» y no se confunde con un segmento corto.
   - **Bloques que fallan:** un bloque que no se pudo preparar, o cuyo trabajo falló, queda en «Error» con su motivo y su segmento se conserva. «Reintentar bloque» lo vuelve a preparar y encolar. Si el segmento ya no existe, se registra como hueco. Al detener o finalizar, los bloques que siguen en error se anotan como huecos: ninguno desaparece en silencio.
   - **Tramos cortos:** un bloque se omite sólo si, contando el solape, no cabe un clip del preset (`duración + solape < preset + 1 s`). La UI muestra la duración real y el motivo.
   - **Cancelación:** pausar, detener o cerrar la app aborta FFmpeg y las consultas de yt-dlp en curso. `runProcess` mata el árbol de procesos, así que no quedan procesos huérfanos.
   - **Reconexión:** espera creciente (3 s, 6 s, 12 s… hasta 2 min). Tras 6 cortes seguidos sin grabar un bloque completo, pasa a «Error» reanudable, sin bucles agresivos.
   - **El trabajo es dueño de su vídeo:** al encolarse, el trabajo enlaza o copia su vídeo en su propia carpeta antes de que el monitor borre el bloque temporal. Sus reintentos usan ese vídeo y nunca la URL del directo.

## Limitaciones (visibles en la UI)
- **Sólo hacia adelante:** `yt-dlp -J` no informa de forma fiable si un directo permite retroceder (DVR), así que la app no lo afirma ni lo intenta. No se recupera lo emitido antes de empezar a vigilar ni lo emitido con el monitor en pausa o la app cerrada; se muestra como «hueco».
- El solape con `-c copy` empieza en el fotograma clave más cercano, así que puede ser algo mayor que el configurado.
- Sólo YouTube, y sólo mediante la URL que aporta el usuario. No se usa ninguna API ni cuenta.
