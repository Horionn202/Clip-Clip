# ADR 0006: Sistema de diseño y borrado masivo con «Deshacer»

- **Estado:** Aceptada
- **Fecha:** 2026-11-20

## Contexto
La interfaz se había quedado apretada (puntos pequeños en el pipeline, controles juntos, navegación con aspecto antiguo) y no se adaptaba a ventanas estrechas. Con muchos trabajos terminados había que borrarlos uno a uno, y «Liberar espacio» se confundía con eliminar del historial.

## Decisión
1. **Tokens centralizados** en `src/renderer/design.css`: colores (fucsia principal, violeta secundario, activo violeta/azul, pendiente gris oscuro, nunca rojo salvo error), espaciado de 4 px, radios, sombras, tipografía, capas (z-index) y medidas. Las variables antiguas (`--panel`, `--accent`…) son alias, así que las hojas existentes heredan el aspecto nuevo.
2. **Componentes** en `src/renderer/components/`: `AppShell`, `Sidebar` (completa ≥ 1024 px, compacta con tooltips en 768–1023 px, cajón por debajo de 768 px), y en `ui.tsx` `Icon`, `Button` (estados hover, foco, deshabilitado y carga), `IconButton`, `PageHeader`, `StatusPill`, `SectionCard`, `EmptyState`, `Skeleton`, `ToastHost`/`useToasts` y `Menu`. El `Modal` existente ya tenía foco atrapado, Escape, scroll interno y pie fijo.
3. **Liberar espacio** sigue siendo un flujo aparte: nunca borra trabajos, sólo archivos regenerables; los clips pendientes de exportar y los exportados se conservan.
4. **Borrado masivo** (`src/main/bulkDelete.ts`, `src/shared/bulk.ts`):
   - sólo trabajos terminados (ni en curso ni renderizando ni retranscribiendo);
   - carpetas validadas dentro de `jobs/` (id seguro, nunca la propia carpeta raíz);
   - los exports sólo se borran si son el archivo de vídeo registrado de un clip elegido, fuera de la carpeta interna y no compartido con otro trabajo;
   - «Eliminar del historial» conserva los exports; «Eliminar por completo» los manda también a la Papelera;
   - a partir de 10 trabajos o 50 clips hay que escribir «BORRAR» (lo comprueba también el proceso principal);
   - nada se borra al momento: las carpetas se apartan a `pending-delete/` durante 15 s (botón «Deshacer» en el aviso) y después van a la Papelera; al cerrar la app se confirma lo pendiente y los restos de un cierre brusco se limpian al iniciar.

## Consecuencias
- En Resultados la selección es de clips (exportar varios a la vez); borrar trabajos completos se hace desde Trabajos.
- «Deshacer» sólo existe durante 15 s; después, lo borrado está en la Papelera de reciclaje.

## Revisión (2026-11-21): una sola ruta de borrado
- La ruta antigua `jobs:delete` (diálogo nativo + `fs.rmSync` de la carpeta del trabajo) se redirigió al mismo `BulkDeleter`: apartar → quitar del historial → «Deshacer» 15 s → Papelera. Ya no hay borrado permanente de datos del usuario.
- Los traslados reintentan con espera (100 ms → 2 s) ante `EPERM`, `EBUSY`, `ENOTEMPTY` y `EACCES`. Si siguen bloqueados, el trabajo se conserva intacto (nunca se quita del historial sin haber movido su carpeta) y el aviso ofrece «Cerrar vista previa y reintentar».
- Antes de borrar, la interfaz pausa y descarga los reproductores de la página, que eran la causa habitual del bloqueo en Windows.
- Borrado de clips desde Resultados (`clips:delete`): se apartan su MP4 interno, sus subtítulos y su miniatura, y el trabajo se actualiza. Se puede deshacer. Si se eligen todos los clips, se elimina el trabajo completo, para no dejar registros vacíos. Los exportados se conservan o van a la Papelera, según la elección del modal.
- Los duplicados del solape de los directos también van a la Papelera.
