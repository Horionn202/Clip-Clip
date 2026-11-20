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

## Limitaciones (visibles en la UI)
- **Sin DVR:** no se recupera lo emitido antes de empezar a vigilar, ni lo emitido mientras el monitor estaba pausado o la app cerrada. Se muestra como «hueco».
- El solape con `-c copy` empieza en el fotograma clave más cercano, así que puede ser algo mayor que el configurado.
- Sólo YouTube, y sólo mediante la URL que aporta el usuario. No se usa ninguna API ni cuenta.
