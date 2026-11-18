# Avisos de terceros

Clip Clip se distribuye bajo licencia MIT. Incluye o puede incluir los siguientes componentes de terceros:

| Componente | Licencia | ¿Se redistribuye? | Notas |
|---|---|---|---|
| Electron / Chromium / Node.js | MIT + licencias de Chromium | Sí (runtime) | `LICENSES.chromium.html` se instala junto al ejecutable. |
| React, React DOM | MIT | Sí | |
| Zod | MIT | Sí | |
| Logo de Clip Clip (`resources/brand/clip-clip-logo.png`) | Propiedad del proyecto | Sí (icono y recursos de marca) | Marca de Clip Clip; no se incluye bajo la licencia MIT del código. |
| FFmpeg / FFprobe | LGPL-2.1+ o GPL-2.0+ según la build | Sólo si se colocan en `resources/bin` antes de empaquetar | Las builds "essentials"/"full" de gyan.dev y BtbN son **GPL**: si las redistribuyes debes ofrecer el código fuente correspondiente (https://ffmpeg.org/download.html) y el texto de la licencia. Alternativa: no empaquetarlas y que el usuario las instale (por defecto). |
| yt-dlp | Unlicense (dominio público) | Sólo si se coloca en `resources/bin` | El binario `yt-dlp.exe` incluye componentes Python con sus propias licencias (ver https://github.com/yt-dlp/yt-dlp). |
| openai-whisper | MIT | No (lo instala el usuario con pip) | Los pesos de los modelos (MIT) se descargan en el primer uso a `%USERPROFILE%\.cache\whisper`. |
| faster-whisper / CTranslate2 | MIT | No (opcional, lo instala el usuario con pip) | Modelos convertidos de Systran y mobiuslabsgmbh (MIT) desde Hugging Face, sólo con confirmación. |
| PyTorch | BSD-3-Clause | No (lo instala el usuario) | Las ruedas CUDA incluyen bibliotecas de NVIDIA bajo sus propios términos. |
| Ollama | MIT | No (lo instala el usuario) | Cada modelo tiene su propia licencia (p. ej. Llama 3.2 Community License, Gemma Terms of Use, Qwen/Apache-2.0). Revísala antes de uso comercial. |

Por defecto el instalador **no** incluye FFmpeg, yt-dlp, Whisper ni modelos; la app los detecta en el sistema.
