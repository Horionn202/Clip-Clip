"""Diagnóstico del motor de transcripción. Imprime UN objeto JSON en stdout.

No recibe datos del usuario. Sólo importa módulos instalados y lista cachés de modelos.
"""
import importlib.util
import json
import os
import sys

out = {"python": sys.version.split()[0], "errors": []}

def has(mod):
    try:
        return importlib.util.find_spec(mod) is not None
    except Exception:
        return False

out["whisper"] = has("whisper")

try:
    import torch  # noqa: E402
    out["torch"] = torch.__version__
    out["torch_cuda"] = torch.version.cuda
    ok = bool(torch.cuda.is_available())
    out["cuda_available"] = ok
    if ok:
        out["cuda_device"] = torch.cuda.get_device_name(0)
        out["cuda_vram_mb"] = int(torch.cuda.get_device_properties(0).total_memory / (1024 * 1024))
except Exception as e:  # torch ausente o roto
    out["torch"] = None
    out["torch_cuda"] = None
    out["cuda_available"] = False
    out["errors"].append("torch: " + str(e)[:200])

try:
    import faster_whisper  # noqa: E402
    out["faster_whisper"] = getattr(faster_whisper, "__version__", "instalado")
except Exception:
    out["faster_whisper"] = None

try:
    import ctranslate2  # noqa: E402
    out["ctranslate2"] = ctranslate2.__version__
    n = ctranslate2.get_cuda_device_count()
    out["ct2_cuda_devices"] = n
    out["ct2_cuda_compute_types"] = sorted(ctranslate2.get_supported_compute_types("cuda")) if n > 0 else []
except Exception as e:
    out["ctranslate2"] = None
    out["ct2_cuda_devices"] = 0
    out["ct2_cuda_compute_types"] = []

home = os.path.expanduser("~")
wdir = os.path.join(os.getenv("XDG_CACHE_HOME", os.path.join(home, ".cache")), "whisper")
hf = os.getenv("HF_HUB_CACHE") or os.path.join(os.getenv("HF_HOME", os.path.join(home, ".cache", "huggingface")), "hub")

def listdir(p, pred):
    try:
        return sorted(x for x in os.listdir(p) if pred(os.path.join(p, x), x))
    except Exception:
        return []

out["cache_openai"] = listdir(wdir, lambda full, n: n.endswith(".pt") and os.path.getsize(full) > 1_000_000)
out["cache_faster"] = listdir(hf, lambda full, n: "faster" in n and os.path.isdir(os.path.join(full, "snapshots")))

print(json.dumps(out))
