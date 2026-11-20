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
