# Revisión de seguridad (v0.1)

## Superficie y controles

| Área | Riesgo | Control implementado | Prueba |
|---|---|---|---|
| Renderer | XSS → acceso a Node | `contextIsolation`, `sandbox`, `nodeIntegration:false`, CSP estricta (`script-src 'self'`, `media-src clip:`), bloqueo de navegación y `window.open` | Verificado en ejecución: `typeof require/process === 'undefined'`, meta CSP presente en build |
| IPC | Mensajes maliciosos | Origen del emisor verificado (dev URL o `index.html` exacto), esquemas zod `.strict()`, ids UUID, `exportDir` sólo por diálogo nativo | `tests/ipc.test.ts` |
| URL | SSRF / inyección de opciones | Sólo http(s) públicas, sin credenciales, sin hosts privados/locales, sin espacios; `--` antes de la URL en yt-dlp | `tests/validation.test.ts` |
| Procesos | Inyección de comandos | `spawn` con `shell:false` y argumentos en array; subtítulos referenciados por nombre relativo validado (`^[A-Za-z0-9_.-]+\.ass$`) con `cwd` | `tests/queue.test.ts`, `tests/media.test.ts` |
| Subtítulos | Inyección de tags ASS | `{`, `}`, `\` y controles sustituidos | `tests/media.test.ts` |
| Rutas | Traversal | `isInside`/`resolveInside`; protocolo `clip://` sólo sirve `.mp4` dentro de `jobs\<id>\clips` | `tests/ipc.test.ts` |
| Archivos del usuario | Borrado/sobrescritura | Borrado sólo bajo `jobs\<id>` y con confirmación nativa; export con `COPYFILE_EXCL` y nombre único | revisión de código |
| Recursos | DoS por vídeos enormes | Límites de duración, tamaño (`--max-filesize`), espacio libre, concurrencia 1–2, cola ≤ 10, timeouts por proceso | revisión de código |
| IA | Ollama remoto / exfiltración | Host restringido a 127.0.0.1/localhost/[::1] en esquema y cliente | `tests/ipc.test.ts` |
| Credenciales | Fugas | No se usan cookies ni cuentas; logs redactan `token/key/sig/cookie/authorization`; `.gitignore` excluye `.env`, cookies, claves | revisión |
| Errores | Fuga de detalles | UI recibe mensajes amigables; detalles sólo en `logs\app.log` | `tests/queue.test.ts` |

## `npm audit` (2026-11-18)
- `npm audit --omit=dev`: **0 vulnerabilidades** (lo que se distribuye).
- Dependencias de desarrollo: 14 avisos (5 moderados, 9 altos) derivados de:
  - `picomatch ≤ 4.0.7` (ReDoS) vía `vite`, `vitest`, `tinyglobby`.
  - `minimatch 7–11.0.0` (DoS) vía `electron-builder`.
  La «solución» propuesta es degradar a versiones mayores antiguas (`electron-builder 25`, `vitest 3`). **Aceptado**: sólo afectan a herramientas de build con patrones controlados por el proyecto, no al runtime. Revisar cuando haya parches upstream.

## Riesgos abiertos
- Instalador sin firma de código (SmartScreen avisará). Requiere certificado.
- Sin auto-actualización: el usuario debe actualizar manualmente yt-dlp/FFmpeg.
- yt-dlp y Whisper son ejecutables de terceros que se ejecutan con los permisos del usuario; se recomienda instalarlos desde winget/pip oficiales.
- Si se empaqueta FFmpeg GPL, hay obligaciones de licencia (ver `THIRD_PARTY_NOTICES.md`).

## Revisión v0.2 (GPU, métricas y meta de clips) — 2026-11-18

| Área | Riesgo | Control | Prueba |
|---|---|---|---|
| Scripts Python (`probe.py`, `fw_transcribe.py`) | Inyección / ejecución arbitraria | Rutas fijas dentro de `resources/python` (empaquetadas como recursos, no editables desde el renderer); `spawn` sin shell y argumentos estructurados con `argparse`; `probe.py` no recibe datos del usuario | `tests/transcribe.test.ts` |
| Ruta de `python.exe` | Ejecutable arbitrario | Validada como ruta absoluta `.exe` por zod; autodetección junto a `whisper.exe` o en `PATH`, excluyendo el alias de Microsoft Store | `tests/ipc.test.ts` |
| Comandos de instalación de Torch CUDA | Instalación silenciosa/insegura | Nunca se ejecutan: sólo se muestran y se copian al portapapeles; índice oficial `download.pytorch.org` | revisión |
| Descarga de modelos | Descargas pesadas sin consentimiento | Requiere `allowModelDownload` explícito por trabajo; faster-whisper se ejecuta con `local_files_only` sin permiso | revisión + `tests/ipc.test.ts` |
| IPC `source:probe` | SSRF / abuso | Misma validación de URL pública que `jobs:create`, origen del emisor verificado | `tests/ipc.test.ts` |
| Logs estructurados (`events.jsonl`) | Fuga de datos | Sólo dominio de la URL (nunca ruta ni query), redacción de tokens/cookies, rotación a 5 MB | revisión |
| Ollama | Salida desbocada / DoS local | Salida estructurada con esquema JSON y `maxItems`, `num_predict` acotado, timeout por llamada, rondas limitadas (1 + 3) | `tests/analysis.test.ts` |
| VRAM compartida | Fallo por memoria | Descarga del modelo de Ollama antes de transcribir en GPU; reintento con modelo menor y CPU | `tests/transcribe.test.ts` |

`npm audit --omit=dev`: ver resultado de la entrega; no se añadieron dependencias npm nuevas.
