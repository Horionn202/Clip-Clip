"""Transcripción con faster-whisper (CTranslate2). Emite eventos JSON por línea en stdout
y escribe un JSON compatible con openai-whisper (segments + words) en --output.

Argumentos estructurados (argparse): la app nunca construye una línea de shell.
"""
import argparse
import json
import os
import sys
import time

p = argparse.ArgumentParser()
p.add_argument("--audio", required=True)
p.add_argument("--model", required=True)
p.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
p.add_argument("--compute-type", default="float16", choices=["float16", "int8_float16", "int8_float32", "int8", "float32"])
p.add_argument("--language", default=None)
p.add_argument("--output", required=True)
p.add_argument("--local-only", action="store_true")
p.add_argument("--precise", action="store_true", help="Modo preciso: más haces, sin arrastrar el contexto anterior y filtrado de silencios (más lento).")
a = p.parse_args()

def emit(**kw):
    sys.stdout.write(json.dumps(kw) + "\n")
    sys.stdout.flush()

# En Windows, reutiliza las DLL de CUDA/cuDNN que trae Torch CUDA (si está instalado).
if os.name == "nt":
    try:
        import importlib.util
        spec = importlib.util.find_spec("torch")
        if spec and spec.submodule_search_locations:
            lib = os.path.join(list(spec.submodule_search_locations)[0], "lib")
            if os.path.isdir(lib):
                os.add_dll_directory(lib)
    except Exception:
        pass

from faster_whisper import WhisperModel  # noqa: E402

emit(event="loading")
t0 = time.time()
model = WhisperModel(a.model, device=a.device, compute_type=a.compute_type, local_files_only=a.local_only)
emit(event="loaded", seconds=round(time.time() - t0, 2))

if a.precise:
    segments, info = model.transcribe(a.audio, language=a.language or None, word_timestamps=True, beam_size=8, best_of=5, temperature=0.0, condition_on_previous_text=False, vad_filter=True)
else:
    segments, info = model.transcribe(a.audio, language=a.language or None, word_timestamps=True, beam_size=5)
emit(event="info", duration=info.duration, language=info.language)
out = []
for s in segments:
    words = [{"start": w.start, "end": w.end, "word": w.word} for w in (s.words or [])]
    out.append({"start": s.start, "end": s.end, "text": s.text, "words": words})
    emit(event="segment", end=s.end)

with open(a.output, "w", encoding="utf-8") as f:
    json.dump({"language": info.language, "segments": out}, f, ensure_ascii=False)
emit(event="done", segments=len(out))
