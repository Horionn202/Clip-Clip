# ADR 0008: Retención de la grabación de directos y centro de almacenamiento

- **Estado:** Aceptada
- **Fecha:** 2026-11-20

## Contexto
Un monitor detenido conservaba 2,37 GB de segmentos `.ts` (145 clips generados).

**Causa raíz:** con `keepSegments: true`, `cleanupSegments` se saltaba todos los segmentos en cada limpieza, incluidas la de «Detener» y la del final del directo. Además, no había límite de tamaño ni vigilancia del espacio libre, así que la grabación crecía sin aviso hasta que el usuario quitaba el monitor. Los clips viven en sus propios trabajos (el vídeo de cada bloque se enlaza en la carpeta del trabajo), así que la grabación no hacía falta.

## Decisión
1. **Retención explícita** (`LiveSettings.retention`) en lugar de `keepSegments`. La opción se llama «Conservar grabación temporal del directo para edición/reintentos» y muestra la estimación por hora:
   - `none` (por defecto, recomendado);
   - `last10` y `last30` (últimos 10 o 30 minutos);
   - `cap` (hasta 2 GB);
   - `all` (avanzado, con confirmación explícita).
   Los monitores guardados con `keepSegments: true` pasan a `cap`, nunca a `all`.
2. **Plan puro** `planSegmentCleanup`:
   - nunca borra un segmento pendiente, el último procesado (lo necesita el solape) ni los de bloques en proceso o en error (para «Reintentar bloque»);
   - nunca borra el vídeo de un bloque cuyo trabajo sigue activo;
   - después aplica la retención, borrando primero lo más antiguo;
   - al terminar o detener el directo (`final`), lo pendiente ya no se procesará y se limpia también.
3. **Vigilancia en cada ciclo** (`guardDisk`): mide el tamaño real de `live/<id>` y el espacio libre, y estima cuánto falta para llegar al límite.
   - Avisos al 75 % y al 90 % del límite de temporales (2 GB por defecto).
   - Al llegar al límite se libera primero lo procesado. Si no basta, o si el disco baja del mínimo libre (10 GB por defecto), el directo **se pausa de forma segura** con un error accionable y el botón «Liberar temporales ahora».
4. **Sin huérfanos:**
   - limpieza al terminar y al detener (configurable; activada por defecto);
   - al arrancar, se limpian los monitores detenidos o terminados y se borran las carpetas de monitores que ya no existen;
   - toda ruta se valida dentro de `live/<id>`.
5. **Quitar un monitor:** modal con el tamaño que se libera y los clips que se conservan. Los trabajos y exportados no se tocan.
6. **Centro de almacenamiento** («Liberar espacio»): tamaño real de cada categoría y acciones con confirmación (qué se libera, qué se conserva y qué deja de poder editarse):
   - **Categorías:** segmentos de directos, vídeos fuente, audio, frames, clips internos ya exportados, exportados, versión anterior, caché y transcripciones.
   - **Acciones:**
     - limpiar temporales de directos terminados;
     - borrar fuentes **sólo de trabajos con todos sus clips exportados y verificados**;
     - borrar audio y frames;
     - borrar clips internos ya exportados;
     - limpiar caché;
     - revisar datos de versión anterior;
     - eliminar trabajos seleccionados.
7. **Ajustes:**
   - espacio mínimo libre: 10 GB (quien tenía el antiguo valor por defecto de 2 GB pasa a 10 GB);
   - límite de temporales por directo: 2 GB;
   - limpieza automática de temporales terminados: activada;
   - vídeo fuente tras exportar: conservar, borrar tras confirmar la exportación o preguntar.

## Consecuencias
- Los clips, trabajos y exportados nunca se borran desde estas acciones. Los exportados sólo con «Eliminar por completo» (ADR 0006).
- Con «Conservar todo», el directo sólo se frena por el límite global de temporales.
