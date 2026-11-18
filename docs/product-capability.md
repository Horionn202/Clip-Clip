# Capacidad: generación local de clips verticales

**Estado:** v0.1 implementada · **Plataforma:** Windows x64 · **Fecha:** 2026-11-18

## Problema y usuario
Creadores que quieren reutilizar sus vídeos largos (o vídeos con licencia) como clips cortos verticales sin subir su contenido a servicios en la nube ni pagar APIs de IA.

## Resultado esperado
Dada una URL autorizada, un preset (15/30/45/60 s) y un máximo N (1–20), la app produce ≤ N clips MP4 1080×1920 H.264/AAC con subtítulos quemados, sin solapes, con título, hook y justificación, listos para exportar.

## Alcance v0.1
- Incluido: diagnóstico de dependencias, descarga de modelos Ollama, cola persistente con cancelación, historial, galería con preview, edición de títulos, exportación, limpieza configurable, política de uso responsable, instalador NSIS.
- Excluido: publicación en redes, smart crop, edición manual de cortes, cookies/cuentas, macOS/Linux, auto-actualización, firma de código.

## Invariantes (verificadas por pruebas)
1. `clips.length ≤ min(maxClips, 20)` en todas las capas.
2. Para todo par de clips, `a.end ≤ b.start` o `b.end ≤ a.start`.
3. `0 ≤ start < end ≤ duraciónReal`.
4. `round(0,75·preset) ≤ end − start ≤ preset + 1`.
5. Los estados finales (`completed`, `cancelled`, `failed`) son inmutables.
6. El renderer nunca accede a Node, shell ni a rutas arbitrarias; toda entrada IPC pasa por esquemas estrictos.
7. Ningún archivo fuera de `userData\jobs\<id>` se borra; las exportaciones nunca sobrescriben.

## Flujo y estados
`queued → validating → downloading → extractingAudio → transcribing → analyzing → rendering → completed`, con salidas a `cancelled` (usuario) o `failed` (error con mensaje amigable; detalle en el log). Los trabajos activos al cerrar la app pasan a `failed` al reabrir.

## Contrato IPC (preload → main)
| Canal | Entrada | Salida |
|---|---|---|
| `deps:check` | — | `Diagnostics` |
| `settings:get` / `settings:update` | patch estricto (sin `exportDir`) | `Settings` |
| `settings:chooseExportDir` | — (diálogo nativo) | ruta o `null` |
| `ollama:list` / `ollama:pull` | nombre de modelo validado | lista / progreso por evento |
| `jobs:create` | `{url, preset, maxClips, rightsConfirmed: true}` | `Job` |
| `jobs:list`, `jobs:cancel`, `jobs:delete` | id UUID | — / confirmación nativa |
| `clips:rename`, `clips:export`, `clips:exportAll` | ids + título ≤ 100 | `Job` / ruta / número |
| `shell:openJobFolder`, `shell:openExportFolder` | id | — |
| Eventos: `job:update`, `ollama:pullProgress` | — | `Job`, `PullProgress` |

## Decisión de arquitectura (ver [ADR 0001](adr/0001-arquitectura-electron-local.md))
Electron + React + TypeScript + Vite, con tres capas (renderer sin privilegios, preload mínimo, main con toda la E/S). Alternativas consideradas: Tauri (menor tamaño, pero requiere Rust y el ecosistema de procesos/medios en Node es más directo) y una app web local (no cumple «descargable» ni aislamiento de procesos). Almacenamiento en JSON atómico en lugar de SQLite para evitar módulos nativos; reevaluar si el historial supera miles de trabajos.

## Riesgos y limitaciones conocidas
- Calidad de los cortes depende del modelo local; modelos de 3B a veces proponen duraciones erróneas (se corrigen o descartan).
- Whisper en CPU es lento en vídeos largos.
- Crop central: no sigue al hablante (la interfaz `CropStrategy` permite añadir smart crop).
- Previsualización vía `clip://` usa `net.fetch` de archivos; el avance rápido en vídeos muy grandes puede ser limitado.
- La verificación de derechos es una declaración del usuario más filtros técnicos (sin auth, sin directos); no puede garantizar legalidad.

## Siguiente paso recomendado
Prueba end-to-end con un vídeo propio corto y, después, smart crop basado en detección de caras (p. ej. ONNX local) implementando `CropStrategy`.
