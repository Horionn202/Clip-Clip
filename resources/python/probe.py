"""Diagnóstico del motor de transcripción. Imprime UN objeto JSON en stdout.

No recibe datos del usuario. Argumento opcional: ruta (controlada por la app) de un archivo JSON
donde memorizar los hashes ya verificados de los modelos, para no recalcularlos en cada diagnóstico.
"""
import hashlib
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

# --- openai-whisper: un .pt sólo cuenta si su SHA-256 coincide con el oficial ---
# (Whisper vuelve a descargar el modelo entero si el checksum no coincide, p. ej. tras una descarga cortada.)
expected = {}
try:
    import whisper  # noqa: E402
    for url in whisper._MODELS.values():
        parts = url.rstrip("/").split("/")
        expected[parts[-1]] = parts[-2]
except Exception as e:
    out["errors"].append("whisper: " + str(e)[:200])

memo_path = sys.argv[1] if len(sys.argv) > 1 else None
memo = {}
if memo_path:
    try:
        with open(memo_path, "r", encoding="utf-8") as f:
            memo = json.load(f)
    except Exception:
        memo = {}

def sha256_ok(full, name):
    want = expected.get(name)
    if not want:
        return False
    st = os.stat(full)
    key = full + "|" + str(st.st_size) + "|" + str(int(st.st_mtime))
    if memo.get(key) == want:
        return True
    h = hashlib.sha256()
    with open(full, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    ok = h.hexdigest() == want
    if ok:
        memo[key] = want
    return ok

out["cache_openai"] = listdir(wdir, lambda full, n: n.endswith(".pt") and sha256_ok(full, n))

if memo_path:
    try:
        tmp = memo_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(memo, f)
        os.replace(tmp, memo_path)
    except Exception:
        pass

# --- faster-whisper: snapshot con model.bin y sin descargas a medias ---
def faster_ok(full, n):
    if "faster" not in n:
        return False
    snaps = os.path.join(full, "snapshots")
    blobs = os.path.join(full, "blobs")
    try:
        if any(b.endswith(".incomplete") for b in os.listdir(blobs)):
            return False
        return any(os.path.isfile(os.path.join(snaps, s, "model.bin")) for s in os.listdir(snaps))
    except Exception:
        return False

out["cache_faster"] = listdir(hf, faster_ok)

print(json.dumps(out))
