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
- **Whisper**: `tiny` (75 MB), `base` (145 MB), `small` (465 MB), `medium` (1,5 GB), `large` (2,9 GB), `turbo` (1,6 GB). Recomendado: en CPU `base` (equilibrio) o `small` (más preciso); con GPU CUDA `turbo`. **Nunca se descarga sin tu confirmación**: si el modelo no está en caché, Inicio muestra la casilla «Permitir descargar el modelo» con su tamaño. Caché: `%USERPROFILE%\.cache\whisper` (openai-whisper) y `%USERPROFILE%\.cache\huggingface\hub` (faster-whisper).
- Ningún modelo se incluye en el instalador.

## Uso
1. **Inicio**: pega la URL y pulsa **Comprobar vídeo** (obligatorio). Se muestran por separado la **duración del vídeo fuente** (p. ej. «98 min 1 s») y la **duración de cada clip**, el máximo posible de clips, el espacio en disco y el tiempo de transcripción aproximados. Los vídeos de más de 20 minutos requieren una confirmación explícita. Elige la duración de cada clip (15/30/45/60 s) y una **meta de clips** explícita: Rápido (5), Estándar (10), Máximo (hasta 20) o un valor 1–20. La app calcula el máximo sin solapes (`floor(duración / preset)`, tope 20) y la **meta efectiva** = mín(meta, 20, máximo). Confirma que tienes derechos y pulsa **Iniciar**.
2. **Trabajos**: progreso por etapas (`queued → validating → downloading → extractingAudio → transcribing → analyzing → rendering → completed`) con indicador **CPU/GPU**, botón **Cancelar** e historial con meta, máximo factible, candidatos, descartes y resultado.
3. **Resultados**: previsualización, título editable, hook, timestamps, duración, **Exportar**, **Exportar todos**, **Abrir carpeta**, y el resultado honesto `obtenidos/meta`.

### «Hasta 20 clips», nunca «20 garantizados»
- 20 clips de 30 s requieren al menos 600 s de vídeo; uno de 421,86 s admite como máximo 14 de 30 s.
- La IA recibe la meta exacta («genera exactamente N»). Si devuelve menos válidos, se hacen hasta 3 rondas de relleno que sólo piden los que faltan, enviando los intervalos ya elegidos y sólo los tramos libres de la transcripción.
- Cada candidato se valida: timestamps posibles, duración del preset, sin solapes, título/razón útiles (se descartan textos de plantilla como «¿Por qué funciona?»), voz suficiente. Un hook vacío o copiado del título se sustituye por la frase real con la que empieza el clip. La puntuación final combina una **puntuación local determinista** (densidad de habla, frases completas, énfasis, coincidencia del hook con lo dicho) con el score del modelo (si es válido).
- Si no se alcanza la meta, el trabajo termina con, p. ej., `3/5 clips generados: no se encontraron más momentos distintos que cumplan los criterios`; nunca con un «Listo» genérico.

La app no publica en redes sociales.

## Aceleración por GPU (NVIDIA CUDA)

**«GPU NVIDIA detectada» no es lo mismo que «CUDA habilitado»**. La app comprueba ambas cosas por separado en Configuración → *GPU y motor de transcripción*:

| Dato | Cómo se obtiene |
|---|---|
| GPU NVIDIA, VRAM, driver | `nvidia-smi` |
| Python / Torch / versión CUDA de Torch | `resources/python/probe.py` (ejecutado sin argumentos de usuario) |
| CUDA realmente usable por Whisper | `torch.cuda.is_available()`; un Torch `+cpu` nunca cuenta como GPU |
| CUDA en faster-whisper | `ctranslate2.get_cuda_device_count()` y tipos de cómputo `float16` |

**Motores** (selección automática del mejor disponible, o fijo en Configuración):
1. `faster-whisper · GPU` (CTranslate2): el más rápido y con menos VRAM; `float16`, o `int8_float16` si la VRAM va justa.
2. `openai-whisper · GPU`: `--device cuda` con FP16 (sin `--fp16 False`); opción FP32 para GPUs con problemas de FP16.
3. `openai-whisper · CPU`: siempre `--fp16 False`.

Si el modelo elegido no cabe en la VRAM con un margen del 5 % (aprox.: openai-whisper turbo ≈ 6 GB, medium ≈ 5 GB, large ≈ 10 GB) se usa uno menor con aviso; con 6 GB, por ejemplo, se usa `medium`.

**GTX 16xx (p. ej. GTX 1660 SUPER, GTX 1650):** Whisper en FP16 produce `NaN` en estas GPUs (verificado: el CLI imprime «Skipping … due to ValueError … invalid values» y sale con código 0 sin escribir la transcripción). En precisión «Automática» la app usa **FP32 en GPU** en esta serie; en otras GPUs usa FP16 y, si falla, reintenta en FP32 antes de bajar de modelo o pasar a CPU. Medido en GTX 1660 SUPER: `medium` FP32 transcribió 120 s de audio en ≈ 72 s incluyendo la carga del modelo.

**Validación de la salida:** un código de salida 0 no basta. Tras cada intento se busca el JSON generado (nombre esperado u otro `.json` nuevo en la carpeta del trabajo) y se valida que sea parseable, con segmentos, timestamps y texto. Si no, el trabajo falla con «Whisper terminó sin generar un JSON válido; abre Configuración → Diagnóstico» y cada intento queda en *Última ejecución* y en `logs/events.jsonl` (`transcribe_attempt`: motor, modelo, dispositivo, precisión, argumentos sin rutas, código de salida, últimas líneas de stdout/stderr, archivo esperado y archivos presentes). Si la GPU falla durante la transcripción (falta de memoria, cuDNN…) se reintenta con un modelo menor en GPU y después en CPU, siempre con modelos ya descargados o con tu permiso. Antes de transcribir en GPU se pide a Ollama que libere su modelo de la VRAM (`keep_alive: 0`).

### Habilitar CUDA en Windows (pasos manuales)
La app **no instala nada automáticamente**; muestra estos comandos con un botón «Copiar comandos». Con el Python del entorno de Whisper (PowerShell):

```bash
& "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe" -m pip uninstall -y torch
```

```bash
& "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe" -m pip install torch --index-url https://download.pytorch.org/whl/cu126
```

- Verificado en el índice oficial de PyTorch (2026-11-18): hay ruedas `torch 2.14.1+cu126` para **Python 3.14** en Windows x64. CUDA 12.6 es compatible con GPUs Turing como la GTX 1660 SUPER y con drivers recientes. Descarga ≈ 2,5 GB.
- Opcional, faster-whisper: `pip install -U faster-whisper` (ruedas de CTranslate2 4.9 para cp314). Según su documentación oficial, en GPU necesita **cuBLAS para CUDA 12 y cuDNN 9**; en Windows su instalación por pip sólo está documentada para Linux. La app intenta reutilizar las DLL que trae Torch CUDA; si CTranslate2 no detecta CUDA, se queda con openai-whisper en GPU.
- Después pulsa **Volver a comprobar**: «CUDA habilitado para Whisper» debe decir **sí** y «Motor activo» debe mostrar **GPU**.

### Cómo comprobar que se usa la GPU
- Inicio muestra `Transcripción: GPU · …` (en verde) o `CPU` (en ámbar).
- Durante la transcripción, el mensaje empieza por `[GPU]` o `[CPU]` y muestra % · audio procesado · tiempo transcurrido · velocidad (`2.5× tiempo real`) · tiempo restante (sólo cuando hay muestra suficiente). Se distingue «Descargando modelo» de «Iniciando modelo» y de la transcripción.
- Configuración → **Última ejecución**: tiempo por fase, render por clip, total, motor, modelo y velocidad.
- `nvidia-smi` en otra terminal debe mostrar un proceso `python.exe` usando memoria de la GPU.

### Tiempos orientativos (no son garantías)
Medido en este equipo (CPU de escritorio, sin CUDA): un audio de 630 s con `tiny` en CPU tardó 382 s (≈ 1,6× tiempo real); `small` en CPU es varias veces más lento (≈ 11 min para 7 min de vídeo). En GPU CUDA, openai-whisper y faster-whisper suelen ir muchas veces más rápido que en CPU, según el modelo y la tarjeta. El análisis con Ollama `llama3.2` (3B) tardó ≈ 12 s para 5 clips.

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
| `logs\events.jsonl` | Eventos estructurados por trabajo (sólo dominio de la URL, métricas, rondas de análisis) |

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
| La transcripción es muy lenta | Mira el indicador CPU/GPU. Si dice CPU y tienes NVIDIA, sigue «Habilitar CUDA en Windows». En CPU usa `base`. |
| «GPU NVIDIA detectada» pero «CUDA habilitado: no» | Torch es la versión `+cpu`: reinstálalo desde el índice `cu126` (ver arriba). |
| Falta de memoria en GPU | La app reintenta con un modelo menor y luego en CPU. Prueba `turbo` con faster-whisper o `small` con openai-whisper; cierra otras apps que usen la GPU. |
| Resultados raros con FP16 (texto vacío o repetido) o «Whisper terminó sin generar un JSON válido» | En GTX 16xx ya se usa FP32 automáticamente; en otras GPUs, Configuración → Precisión en GPU → FP32. Revisa *Última ejecución* para ver el motivo de cada intento. |
| «El modelo … no está descargado» | Marca «Permitir descargar el modelo» en Inicio o elige un modelo ya descargado. |
| Menos clips que la meta | El resultado indica `obtenidos/meta` y el motivo; Configuración → Última ejecución muestra rondas y descartes. Prueba un modelo de Ollama mayor. |
| La descarga falla | El vídeo puede ser privado, con restricción de edad o geobloqueado; actualiza yt-dlp (`winget upgrade yt-dlp.yt-dlp`). |
| «La IA no propuso ningún clip válido» | Prueba otro preset u otro modelo (más grande). |
| Detalle técnico | `%APPDATA%\ClipsVirales\logs\app.log` |

## Uso responsable
Procesa sólo contenido propio o con permiso, respeta los términos de cada plataforma y atribuye a los autores. La política completa está en la app (sección «Uso responsable»).
