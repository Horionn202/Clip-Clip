# ADR 0001: Electron + React + TypeScript con procesamiento 100 % local

- **Estado:** Aceptada
- **Fecha:** 2026-11-18

## Contexto
Se necesita una app descargable para Windows que descargue vídeos autorizados, transcriba, analice con IA y renderice clips 9:16, sin nube, sin APIs de pago y sin bases de datos remotas. Depende de herramientas externas (FFmpeg, yt-dlp, Whisper, Ollama) y maneja entradas no confiables (URLs, respuestas de un LLM).

## Decisión
1. **Electron + React + TypeScript**, renderer construido con **Vite**; main y preload compilados con `tsc` (CommonJS).
2. **Tres capas aisladas:** renderer sin privilegios (`contextIsolation`, `sandbox`, sin `nodeIntegration`, CSP), preload con API mínima por `contextBridge`, y main con toda la E/S, procesos y cola.
3. **IPC validado** con esquemas zod estrictos y verificación del origen del emisor.
4. **Procesos externos** con `spawn` (`shell:false`) y argumentos estructurados; cancelación por `AbortController` y `taskkill /T`.
5. **Almacenamiento** en JSON con escritura atómica en `app.getPath('userData')`.
6. **IA local** vía HTTP a Ollama restringido a loopback; **transcripción** con openai-whisper CLI (timestamps por palabra).
7. **Dependencias detectadas, no empaquetadas por defecto**; opción de incluir FFmpeg/yt-dlp desde `resources/bin`.
8. **Encuadre** detrás de la interfaz `CropStrategy` (crop central hoy, smart crop después).

## Alternativas consideradas
- **Tauri:** instalador más pequeño, pero exige Rust y el ecosistema de procesos/medios en Node es más directo para este equipo.
- **App web local + navegador:** no es "descargable" como app y complica el aislamiento y la gestión de procesos.
- **SQLite:** mejor para historiales grandes, pero añade módulos nativos y recompilación por versión de Electron. Reevaluar si el historial supera miles de trabajos.
- **faster-whisper / whisper.cpp:** más rápidos; se pueden añadir como motor alternativo detrás de la misma etapa.

## Consecuencias
- (+) Superficie de ataque del renderer mínima; toda entrada pasa por validación en main.
- (+) Sin módulos nativos: builds reproducibles con `electron-builder` NSIS.
- (−) Instalador de ~120 MB por Chromium.
- (−) El usuario debe instalar Ollama y Whisper (Python); mitigado con la pantalla de diagnóstico guiada.
- (−) Calidad del análisis limitada por el modelo local elegido.
