# ADR 0009: Migración de ClipsVirales verificable, reparable y liberable por partes

- **Estado:** Aceptada
- **Fecha:** 2026-11-21

## Contexto
Con un marcador `migration-clipsvirales.json` de una migración anterior, «Migrar y enviar lo antiguo a la Papelera» devolvía `already` sin migrar nada. Después `verifyMigration()` encontraba archivos de la copia antigua que no estaban en Clip Clip y, con razón, bloqueaba el borrado. Pero mostraba 50 avisos `no verificado: …` y no ofrecía ninguna salida: ni se liberaba espacio ni había forma de repararlo.

**Causa raíz:** la existencia del marcador se trataba como «migración terminada para siempre». La verificación, además, contaba como «faltante» lo que el usuario había borrado **a propósito** en Clip Clip después de migrar: trabajos eliminados y vídeos o temporales liberados. Con una «reparación» ingenua, esos trabajos habrían resucitado.

## Decisión
1. **Estado en el marcador** (`state`): `completed`, `partial`, `needs_repair`, `repaired`, `verified` y `legacy_trashed`. Que el marcador exista ya no significa «terminado».
2. **Verificación detallada** (`classifyMissing`): separa lo que falta y hace falta de lo borrado a propósito en Clip Clip.
   - **Borrado a propósito:** un trabajo que ya no está en el historial nuevo tras migrar, o un vídeo, audio, temporal o clip interno cuyo trabajo los liberó (`sourceCleaned`, `tempCleaned`, `archived`).
   - Lo que falta se resume por categoría: vídeos fuente, audio, clips internos, frames, transcripciones y datos.
   - Las carpetas que no se pueden leer se nombran una a una.
3. **Reparación** (`repairLegacy`):
   - copia o enlaza **sólo** lo que falta y hace falta;
   - los vídeos y el audio se enlazan con enlace duro y, si no se puede, se copian; se informa de los bytes copiados;
   - nunca sobrescribe nada del directorio nuevo y nunca resucita lo borrado a propósito;
   - el historial sólo se vuelve a fusionar si faltan trabajos que nunca se migraron;
   - después vuelve a verificar y guarda el estado.
4. **Liberación por partes** (`freeLegacy`). El renderer sólo elige `data`, `install` o `exports`; las rutas las decide el proceso principal.
   - Deben llamarse exactamente `ClipsVirales` y no coincidir con las de Clip Clip.
   - Lo que usa la configuración actual (p. ej. Python con CUDA) se conserva.
   - **Datos:** sólo con la migración verificada.
   - **Instalación antigua:** siempre, de forma independiente.
   - **Exports antiguos:** sólo con confirmación explícita y nunca si son la carpeta de exportación actual.
   - Si la Papelera falla, no se borra nada de forma permanente y se puede reintentar.
5. **Espacio honesto:** lo enlazado con Clip Clip comparte el espacio, así que liberar la copia antigua no lo recupera. Se muestra sólo el espacio que de verdad se libera (archivos con `nlink = 1`).
6. **Modal** con los estados A (verificado), B (faltan archivos: resumen, «Reparar migración», «Ver archivos faltantes», «Conservar copia antigua por ahora»), C (error de lectura con reintento), D (instalación antigua aparte) y E (exports antiguos con ruta, tamaño, «Abrir carpeta» y Papelera con confirmación). Siempre hay una acción posible. El flujo antiguo «Migrar y liberar» ya no lista 50 avisos: deja el estado en `needs_repair` y remite a la reparación.
7. **Centro de almacenamiento:** tarjetas separadas para los datos de la versión anterior (con su estado y la acción siguiente), la instalación antigua, los exports antiguos y la Papelera de Windows. Una acción sin nada que liberar explica el motivo y el siguiente paso, en vez de mostrar un botón que no hace nada.
8. **Sólo en desarrollo:** `CLIP_CLIP_LEGACY_ROOT` apunta las rutas de la versión anterior a una carpeta de prueba, para que las pruebas manuales nunca toquen los datos reales.
