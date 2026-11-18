# Capacidad: generación local de clips verticales

**Estado:** v0.2 (GPU + meta de clips) · **Plataforma:** Windows x64 · **Fecha:** 2026-11-18

## Problema y usuario
Creadores que quieren reutilizar sus vídeos largos (o vídeos con licencia) como clips cortos verticales sin subir su contenido a servicios en la nube ni pagar APIs de IA.

## Resultado esperado
Dada una URL autorizada, un preset (15/30/45/60 s) y una **meta** N (1–20), la app produce **hasta** N clips MP4 1080×1920 H.264/AAC con subtítulos quemados, sin solapes, con título, hook y justificación, listos para exportar, e informa honestamente cuántos obtuvo.

## Contrato «hasta 20 clips»
1. El producto promete **hasta 20** clips por trabajo, nunca 20 garantizados.
2. El usuario elige una meta explícita (Rápido 5 · Estándar 10 · Máximo hasta 20 · o 1–20). No hay valor implícito: «Iniciar» se desactiva hasta elegirla.
3. **Máximo factible** = `min(20, floor(duración / preset))`. Ej.: 421,86 s con preset 30 s → 14; 20 clips de 30 s requieren ≥ 600 s.
4. **Meta efectiva** = `min(meta, 20, máximo factible)`. Se muestra antes de iniciar («Comprobar vídeo») y se guarda en el trabajo.
5. Selección por rondas: la ronda 1 pide exactamente la meta efectiva; hasta 3 rondas de relleno piden sólo los que faltan, sobre los tramos libres y con los intervalos ya elegidos. Se para si una ronda no aporta ninguno o si no quedan huecos.
6. Cada candidato pasa por validación de calidad (timestamps, duración, solapes, título/razón no genéricos, sin texto de plantilla, voz suficiente) y por una puntuación local determinista combinada con el score del modelo.
7. Resultado: `N/N clips generados`, o `k/N clips generados: <motivo>` si es parcial. El historial guarda meta, máximo factible, meta efectiva, rondas, candidatos, descartes por motivo y resultado.

## Modelos de IA y selección (v0.3)
- Perfiles Rápido/Equilibrado/Calidad/Personalizado con tamaño, memoria, calidad, velocidad y encaje en GPU (`src/shared/aiProfiles.ts`).
- Antes del análisis se registra la VRAM libre y, después, dónde quedó cargado el modelo (`/api/ps`); nunca se afirma «GPU» si parte del modelo está en CPU/RAM.
- Selección: rechazo de ideas repetidas (similitud ≥ 0,6), bonus de diversidad temporal, puntuación local con densidad, claridad, ajuste a la duración, bordes de frase, énfasis y coincidencia del hook.
- Informe por trabajo visible en el historial: solicitados, máximo posible, meta efectiva, generados, candidatos, descartes por motivo, rondas y modelo.

## Rendimiento y motor de transcripción
- Motores: faster-whisper GPU → openai-whisper GPU → openai-whisper CPU (automático o fijo). CUDA sólo cuenta como disponible si Torch/CTranslate2 lo confirman; una GPU NVIDIA con Torch `+cpu` se trata como CPU y se explica.
- CPU: `--fp16 False`. GPU: FP16 (o `int8_float16` en faster-whisper si la VRAM va justa); FP32 opcional.
- VRAM insuficiente → modelo menor con aviso. Fallo de GPU → modelo menor en GPU y después CPU.
- Los modelos de Whisper sólo se descargan con confirmación explícita por trabajo.
- Métricas persistidas por trabajo: tiempo por fase, render por clip, total, motor/dispositivo, modelos, duración del vídeo, clips finales, velocidad (× tiempo real) y tiempo de descarga del modelo.
- Progreso de transcripción: fase (descargando / iniciando modelo / transcribiendo), %, audio procesado, tiempo transcurrido, velocidad y ETA sólo con muestra suficiente (≥ 20 s de audio y ≥ 10 s desde el primer segmento).

## Alcance
- Incluido: diagnóstico de dependencias y GPU, descarga de modelos Ollama, cola persistente con cancelación, historial con métricas, galería con preview, edición de títulos, exportación, limpieza configurable, política de uso responsable, instalador NSIS.
- Excluido: publicación en redes, smart crop, edición manual de cortes, cookies/cuentas, macOS/Linux, auto-actualización, firma de código, instalación automática de Torch CUDA.

## Invariantes (verificadas por pruebas)
1. `clips.length ≤ min(metaEfectiva, 20)` en todas las capas.
2. Para todo par de clips, `a.end ≤ b.start` o `b.end ≤ a.start`.
3. `0 ≤ start < end ≤ duraciónReal`.
4. `round(0,75·preset) ≤ end − start ≤ preset + 1`.
5. Los estados finales (`completed`, `cancelled`, `failed`) son inmutables; `completed` siempre lleva el resumen `obtenidos/meta`.
6. El renderer nunca accede a Node, shell ni a rutas arbitrarias; toda entrada IPC pasa por esquemas estrictos.
7. Ningún archivo fuera de `userData\jobs\<id>` se borra; las exportaciones nunca sobrescriben.
8. CPU ⇒ `--fp16 False`; GPU sólo si CUDA está confirmado por el motor.

## Flujo y estados
`queued → validating → downloading → extractingAudio → transcribing → analyzing → rendering → completed`, con salidas a `cancelled` (usuario) o `failed` (error con mensaje amigable; detalle en el log). Los trabajos activos al cerrar la app pasan a `failed` al reabrir.

## Contrato IPC (preload → main)
| Canal | Entrada | Salida |
|---|---|---|
| `deps:check` | — | `Diagnostics` (incluye `gpu: GpuInfo`) |
| `source:probe` | URL validada | `{title, duration}` |
| `settings:get` / `settings:update` | patch estricto (sin `exportDir`) | `Settings` |
| `settings:chooseExportDir` | — (diálogo nativo) | ruta o `null` |
| `ollama:list` / `ollama:pull` | nombre de modelo validado | lista / progreso por evento |
| `jobs:create` | `{url, preset, maxClips, rightsConfirmed: true, allowModelDownload?}` | `Job` |
| `jobs:list`, `jobs:cancel`, `jobs:delete` | id UUID | — / confirmación nativa |
| `clips:rename`, `clips:export`, `clips:exportAll` | ids + título ≤ 100 | `Job` / ruta / número |
| `shell:openJobFolder`, `shell:openExportFolder` | id | — |
| Eventos: `job:update`, `ollama:pullProgress` | — | `Job`, `PullProgress` |

## Decisión de arquitectura (ver [ADR 0001](adr/0001-arquitectura-electron-local.md))
Electron + React + TypeScript + Vite, con tres capas (renderer sin privilegios, preload mínimo, main con toda la E/S). Almacenamiento en JSON atómico. La transcripción se ejecuta con procesos Python externos con argumentos estructurados (`probe.py`, `fw_transcribe.py`, CLI de openai-whisper).

## Riesgos y limitaciones conocidas
- La calidad de títulos/hooks depende del modelo local; con 3B los títulos tienden a copiar la transcripción.
- La ruta CUDA no se ha podido ejecutar en el equipo de desarrollo (Torch `+cpu`); está cubierta por pruebas con adaptadores simulados.
- faster-whisper en GPU en Windows requiere cuBLAS/cuDNN para CUDA 12; su instalación por pip sólo está documentada oficialmente para Linux.
- Crop central: no sigue al hablante (la interfaz `CropStrategy` permite añadir smart crop).
- La verificación de derechos es una declaración del usuario más filtros técnicos; no puede garantizar legalidad.

## Siguiente paso recomendado
Instalar Torch CUDA (`cu126`) en el equipo con la GTX 1660 SUPER, ejecutar un trabajo real y comparar las métricas de «Última ejecución» con las de CPU.
