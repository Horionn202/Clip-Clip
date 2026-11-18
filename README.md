# ClipsVirales (escritorio, Windows)

Aplicación de escritorio que, a partir de la URL de un vídeo **que tengas derecho a usar**, genera de 1 a 20 clips verticales 9:16 con subtítulos para TikTok, Reels y YouTube Shorts. **Todo se ejecuta en tu equipo**: descarga, transcripción, IA, render, historial y logs. Sin nube, sin APIs de pago y sin bases de datos remotas.

## Requisitos

| Dependencia | Para qué | Instalación recomendada (PowerShell) |
|---|---|---|
| Windows 10/11 x64 | — | — |
| [Ollama](https://ollama.com/download/windows) | Análisis con IA local | Instalador oficial |
| FFmpeg + FFprobe | Audio, metadatos y render | `winget install Gyan.FFmpeg.Essentials` |
| yt-dlp | Descarga | `winget install yt-dlp.yt-dlp` |
| Whisper (openai-whisper) | Transcripción local con marcas por palabra | Python 3.10+ y `pip install -U openai-whisper` |

En el primer inicio la app abre **Configuración → Diagnóstico**, comprueba cada dependencia (Ollama instalado, servicio, modelo, ffmpeg, ffprobe, yt-dlp y Whisper) y muestra instrucciones si falta algo. Las rutas de los ejecutables se pueden indicar manualmente.

### Modelos
- **Ollama**: se elige y descarga desde Configuración (tamaño aproximado indicado: `llama3.2:3b` ≈ 2 GB, `gemma3:4b` ≈ 3,3 GB, `qwen2.5:7b` ≈ 4,7 GB, `llama3.1:8b` ≈ 4,9 GB) o cualquier modelo ya instalado. No está codificado: es un ajuste.
- **Whisper**: `tiny` (75 MB) … `turbo` (1,6 GB). Se descarga automáticamente en la primera transcripción a `%USERPROFILE%\.cache\whisper`.
- Ningún modelo se incluye en el instalador.

## Uso
1. **Inicio**: pega la URL, elige duración (15/30/45/60 s) y máximo de clips (1–20), confirma que tienes derechos y pulsa **Iniciar**.
2. **Trabajos**: progreso por etapas (`queued → validating → downloading → extractingAudio → transcribing → analyzing → rendering → completed`), botón **Cancelar** e historial (`completed`, `cancelled`, `failed`).
3. **Resultados**: previsualización, título editable, hook, timestamps, duración, **Exportar**, **Exportar todos**, **Abrir carpeta**.

La app no publica en redes sociales.

## Desarrollo

```bash
npm install
```

```bash
npm run dev
```

| Comando | Qué hace |
|---|---|
| `npm run dev` | Compila main/preload, arranca Vite (127.0.0.1:5183) y abre Electron |
| `npm test` | Pruebas unitarias e integración (la de FFmpeg se omite si no está instalado) |
| `OLLAMA_TEST_MODEL=llama3.2:latest npm test` | Incluye la prueba real con Ollama |
| `npm run typecheck` | TypeScript estricto en renderer y main |
| `npm run build` | Typecheck + build de producción en `dist/` y `dist-electron/` |
| `npm run package` | Genera el instalador `release/ClipsVirales-Setup-<versión>.exe` (NSIS) |
| `npm run package:dir` | App desempaquetada en `release/win-unpacked` (prueba rápida) |

> npm ≥ 11 bloquea scripts de instalación: `package.json` aprueba explícitamente `electron` y `electron-winstaller` (`allowScripts`). Si el binario de Electron no aparece, ejecuta `node node_modules/electron/install.js`.

### Empaquetar FFmpeg / yt-dlp (opcional)
Copia `ffmpeg.exe`, `ffprobe.exe` y/o `yt-dlp.exe` en `resources/bin/` antes de `npm run package`; se incluyen en `resources\bin` del instalador y tienen prioridad sobre el PATH. Revisa [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): las builds habituales de FFmpeg son GPL. Esos binarios están en `.gitignore`.

## Arquitectura

```
src/
  shared/     tipos, constantes (MAX_CLIPS=20) y validación pura (URL, presets, normalización de candidatos)
  main/       proceso principal (Node): IPC validado con zod, cola, pipeline, almacenamiento, procesos externos
    main.ts         ventana segura, protocolo clip:// para previsualizar, instancia única
    ipc.ts          handlers; valida origen del emisor y cada payload; errores amigables
    ipcSchemas.ts   esquemas zod estrictos
    queue.ts        cola FIFO con concurrencia 1–2 y cancelación por AbortController
    pipeline.ts     validar → descargar → audio → Whisper → Ollama → normalizar → render
    proc.ts         spawn con shell:false, timeouts y kill del árbol de procesos (taskkill /T)
    deps.ts         detección y diagnóstico de dependencias con ayuda accionable
    media.ts        ASS (escapado), CropStrategy (crop central; preparado para smart crop), args FFmpeg
    ollama.ts       cliente HTTP local (sólo 127.0.0.1/localhost)
    store.ts        JSON con escritura atómica (ajustes, trabajos)
  preload/    API mínima `window.clipsApi` vía contextBridge (sandbox)
  renderer/   React + Vite, sin Node; páginas Inicio, Trabajos, Resultados, Configuración, Uso responsable
tests/        Vitest
docs/         especificación de producto y revisión de seguridad
```

Decisiones clave: Electron + React + TypeScript + Vite; renderer con `contextIsolation`, `sandbox`, sin `nodeIntegration` y CSP estricta en producción; el main compila con `tsc` (CommonJS) y el renderer con Vite. Detalle en [docs/product-capability.md](docs/product-capability.md) y [docs/security.md](docs/security.md).

## Almacenamiento local

Todo vive en `app.getPath('userData')` = `%APPDATA%\ClipsVirales`:

| Ruta | Contenido |
|---|---|
| `data\settings.json` | Preferencias |
| `data\jobs.json` | Historial y estado de trabajos |
| `jobs\<id>\source.mp4` | Vídeo descargado (borrable al completar) |
| `jobs\<id>\audio.wav` | Audio temporal (borrado por defecto) |
| `jobs\<id>\transcript.json` | Transcripción con marcas por palabra |
| `jobs\<id>\clips\*.mp4` | Clips renderizados |
| `logs\app.log` | Logs técnicos (rotan a 5 MB; tokens/cookies redactados) |

Los clips exportados se copian (sin sobrescribir) a la carpeta de exportación, por defecto `Vídeos\ClipsVirales`. Borrar un trabajo pide confirmación y nunca toca los clips exportados. Desinstalar no borra los datos.

## Reglas de negocio implementadas
- Máximo absoluto de 20 clips en UI (slider), IPC (zod), prompt, parseo, normalización y comprobación final antes de render.
- Clips sin solapes, dentro de la duración real y con duración entre el 75 % del preset y preset + 1 s; los cortes se ajustan a límites de palabra.
- Si Ollama devuelve JSON inválido se reintenta una vez; se rescata JSON incrustado en texto; candidatos imposibles se descartan; si no queda ninguno, el trabajo falla con un mensaje claro.
- Límites configurables: duración máx. del vídeo, tamaño de descarga, espacio libre mínimo, trabajos simultáneos (1–2), cola máx. 10.
- Sólo contenido público: no se usan cookies ni credenciales y se rechazan directos y vídeos con `needs_auth`/`premium_only`/`subscriber_only`.

## Solución de problemas

| Síntoma | Solución |
|---|---|
| «Faltan dependencias» | Configuración → Diagnóstico muestra el comando exacto. Tras instalar, pulsa *Volver a comprobar* (reinicia si cambió el PATH). |
| «Servicio Ollama» en rojo | Abre Ollama desde el menú Inicio o ejecuta `ollama serve`. |
| Modelo no descargado | Descárgalo desde Configuración o elige uno de «Modelos ya instalados». |
| Whisper no encontrado aunque esté instalado | Indica la ruta, p. ej. `%LOCALAPPDATA%\Programs\Python\Python3xx\Scripts\whisper.exe`. |
| La transcripción es muy lenta | Usa `base` o `small`; con GPU NVIDIA, instala PyTorch con CUDA. |
| La descarga falla | El vídeo puede ser privado, con restricción de edad o geobloqueado; actualiza yt-dlp (`winget upgrade yt-dlp.yt-dlp`). |
| «La IA no propuso ningún clip válido» | Prueba otro preset u otro modelo (más grande). |
| Detalle técnico | `%APPDATA%\ClipsVirales\logs\app.log` |

## Uso responsable
Procesa sólo contenido propio o con permiso, respeta los términos de cada plataforma y atribuye a los autores. La política completa está en la app (sección «Uso responsable»).
