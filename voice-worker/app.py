"""
MCK Voz — worker de clonagem de voz (grátis, no nosso servidor, sem API paga).

Modelo: Chatterbox Multilingual (Resemble AI, licença MIT, uso comercial permitido), idioma "pt".
Opcional: VOICE_T3_REPO=ResembleAI/Chatterbox-Multilingual-pt-br (ajuste fino do português do Brasil, MIT).

Segurança:
- Toda rota /v1/* exige assinatura HMAC-SHA256 (segredo VOICE_WORKER_SECRET, igual no app) sobre
  "<timestamp>.<nonce>.<MÉTODO>.<caminho>.<sha256 do corpo>", com relógio de no máximo 5 min de diferença
  e cada assinatura aceita uma vez só (anti-replay).
- O worker NÃO guarda o áudio original da amostra: só as "condições" do modelo (vetores da voz),
  cifradas em disco com AES-256-GCM (chave VOICE_DATA_KEY, 32 bytes em base64). Excluir = apagar o arquivo.
- Só escuta em 127.0.0.1/rede interna do Docker; o HTTPS público fica no Caddy (porta 443).
- Áudio gerado nunca vai para disco: fica em memória até o app buscar (expira em 10 min).

Dois motores (os dois MIT, no nosso servidor):
- "qualidade": Chatterbox Multilingual fala o texto direto na voz clonada (mais natural, mas lento em CPU).
- "rapido": o app manda um áudio-base (voz neutra, ex.: Gemini TTS grátis) e o OpenVoice v2 (MyShell, MIT) troca o
  timbre pelo da voz clonada (~1x o tempo real em CPU). O app escolhe; se um falhar, tenta o outro ou cai para texto.

Fila: uma fila em memória, processada por UMA thread (o modelo usa toda a CPU). Máximo VOICE_MAX_QUEUE
pedidos na fila (padrão 40); acima disso responde 429 e o app cai para texto/biblioteca.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import os
import queue
import re
import subprocess
import tempfile
import threading
import time
import uuid
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

SECRET = os.environ.get("VOICE_WORKER_SECRET", "")
DATA_KEY_B64 = os.environ.get("VOICE_DATA_KEY", "")
DATA_DIR = os.environ.get("VOICE_DATA_DIR", "/data/voices")
MAX_QUEUE = int(os.environ.get("VOICE_MAX_QUEUE", "40"))
MAX_TEXT = int(os.environ.get("VOICE_MAX_TEXT", "600"))
THREADS = int(os.environ.get("VOICE_THREADS", str(os.cpu_count() or 2)))
T3_REPO = os.environ.get("VOICE_T3_REPO", "").strip()
JOB_TTL = 600
SKEW = 300

if len(SECRET) < 32:
    raise SystemExit("VOICE_WORKER_SECRET ausente ou curto (mínimo 32 caracteres)")
try:
    DATA_KEY = base64.b64decode(DATA_KEY_B64)
    assert len(DATA_KEY) == 32
except Exception:  # noqa: BLE001
    raise SystemExit("VOICE_DATA_KEY deve ter 32 bytes em base64 (openssl rand -base64 32)")
os.makedirs(DATA_DIR, mode=0o700, exist_ok=True)

ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
app = FastAPI(title="MCK Voz", docs_url=None, redoc_url=None, openapi_url=None)

# ---------------- modelo ----------------
_model = None
_model_lock = threading.Lock()
_model_error: Optional[str] = None


def model():
    global _model, _model_error
    with _model_lock:
        if _model is None:
            import torch
            torch.set_num_threads(THREADS)
            from lowmem import load_mtl_lowmem
            try:
                t3_file = None
                if T3_REPO:
                    # Ajuste fino pt-BR (mesma arquitetura; só troca os pesos do T3).
                    from huggingface_hub import hf_hub_download
                    t3_file = hf_hub_download(T3_REPO, "t3_pt_br.safetensors")
                _model = load_mtl_lowmem(t3_file=t3_file)
                _model_error = None
            except Exception as e:  # noqa: BLE001
                _model_error = str(e)[:300]
                raise
        return _model


_ov = None
_ov_lock = threading.Lock()
_src_se_cache: dict[str, object] = {}


def ov():
    """OpenVoice v2 ToneColorConverter (MIT), checkpoint myshell-ai/OpenVoiceV2/converter."""
    global _ov
    with _ov_lock:
        if _ov is None:
            from huggingface_hub import hf_hub_download
            from openvoice import api
            orig = api.OpenVoiceBaseClass.__init__
            api.OpenVoiceBaseClass.__init__ = lambda self, config_path, device="cpu", **kw: orig(self, config_path, device)
            cfg = hf_hub_download("myshell-ai/OpenVoiceV2", "converter/config.json")
            ck = hf_hub_download("myshell-ai/OpenVoiceV2", "converter/checkpoint.pth")
            c = api.ToneColorConverter(cfg, device="cpu", enable_watermark=False)
            c.watermark_model = None
            c.load_ckpt(ck)
            _ov = c
        return _ov


# ---------------- segurança ----------------
_seen: dict[str, float] = {}
_seen_lock = threading.Lock()


def check_sig(method: str, path: str, body: bytes, ts: str, sig: str, nonce: str = "") -> None:
    try:
        t = int(ts)
    except Exception:  # noqa: BLE001
        raise HTTPException(401, "assinatura inválida")
    now = int(time.time())
    if abs(now - t) > SKEW:
        raise HTTPException(401, "relógio fora do limite")
    if not re.fullmatch(r"[0-9a-f]{16,64}", nonce or ""):
        raise HTTPException(401, "assinatura inválida")
    msg = f"{ts}.{nonce}.{method.upper()}.{path}.{hashlib.sha256(body).hexdigest()}".encode()
    expected = hmac.new(SECRET.encode(), msg, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig or ""):
        raise HTTPException(401, "assinatura inválida")
    with _seen_lock:
        for k in [k for k, v in _seen.items() if v < now - SKEW * 2]:
            _seen.pop(k, None)
        if sig in _seen:
            raise HTTPException(401, "assinatura já usada")
        _seen[sig] = now


@app.middleware("http")
async def auth(request: Request, call_next):
    if request.url.path.startswith("/v1/"):
        body = await request.body()
        try:
            check_sig(request.method, request.url.path, body, request.headers.get("x-mck-ts", ""), request.headers.get("x-mck-sig", ""), request.headers.get("x-mck-nonce", ""))
        except HTTPException as e:
            return JSONResponse({"error": e.detail}, status_code=e.status_code)
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store"
    return resp


# ---------------- armazenamento cifrado das vozes ----------------
def voice_path(vid: str, kind: str = "cb") -> str:
    return os.path.join(DATA_DIR, f"{vid}.bin" if kind == "cb" else f"{vid}.{kind}.bin")


def save_conds(vid: str, conds, kind: str = "cb") -> None:
    import torch
    buf = io.BytesIO()
    torch.save(conds, buf)
    nonce = os.urandom(12)
    data = nonce + AESGCM(DATA_KEY).encrypt(nonce, buf.getvalue(), f"{vid}:{kind}".encode())
    tmp = voice_path(vid, kind) + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.chmod(tmp, 0o600)
    os.replace(tmp, voice_path(vid, kind))


def load_conds(vid: str, kind: str = "cb"):
    import torch
    with open(voice_path(vid, kind), "rb") as f:
        raw = f.read()
    plain = AESGCM(DATA_KEY).decrypt(raw[:12], raw[12:], f"{vid}:{kind}".encode())
    return torch.load(io.BytesIO(plain), weights_only=False)


def to_wav24k(audio: bytes, trim: bool = True) -> bytes:
    """Qualquer formato (ogg/opus, mp3, m4a, wav, webm) → WAV mono 24 kHz, sem silêncio nas pontas."""
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "in")
        dst = os.path.join(d, "out.wav")
        with open(src, "wb") as f:
            f.write(audio)
        af = ["-af", "silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.6"] if trim else []
        r = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", src, "-ac", "1", "-ar", "24000", *af,
                            "-t", "300", dst], capture_output=True, timeout=120)
        if r.returncode != 0:
            raise HTTPException(400, "não foi possível ler o áudio da amostra")
        with open(dst, "rb") as f:
            return f.read()


# ---------------- fila ----------------
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
q: "queue.PriorityQueue[tuple[int, float, str]]" = queue.PriorityQueue()


def pcm_result(wav_tensor, sr: int) -> dict:
    import torch
    pcm = (wav_tensor.reshape(-1).clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes()
    return {"ok": True, "rate": sr, "pcm16_b64": base64.b64encode(pcm).decode(), "seconds": round(len(pcm) / 2 / sr, 2)}


def run_job(job: dict) -> None:
    import torch
    if job["kind"] == "register":
        with tempfile.TemporaryDirectory() as d:
            full = os.path.join(d, "amostra.wav")
            with open(full, "wb") as f:
                f.write(job.pop("wav"))
            # OpenVoice: timbre da amostra inteira (rápido, pouca memória).
            save_conds(job["voice_id"], ov().extract_se([full]).cpu(), "ov")
            # Chatterbox: usa os primeiros segundos (o modelo só lê ~10 s).
            if os.environ.get("VOICE_QUALITY", "1") == "1":
                m = model()
                m.prepare_conditionals(full, exaggeration=0.5)
                save_conds(job["voice_id"], m.conds)
        job["result"] = {"ok": True}
        return
    if job["kind"] == "convert":
        c = ov()
        tgt = load_conds(job["voice_id"], "ov")
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "base.wav")
            with open(src, "wb") as f:
                f.write(job.pop("wav"))
            key = job.get("base_key") or ""
            src_se = _src_se_cache.get(key) if key else None
            if src_se is None:
                src_se = c.extract_se([src])
                if key:
                    _src_se_cache[key] = src_se
            out = os.path.join(d, "out.wav")
            c.convert(src, src_se, tgt, output_path=out, tau=float(job.get("tau", 0.3)))
            import soundfile as sf
            data, sr = sf.read(out, dtype="float32")
            job["result"] = pcm_result(torch.from_numpy(data), sr)
        return
    m = model()
    conds = load_conds(job["voice_id"])
    m.conds = conds
    with torch.inference_mode():
        wav = m.generate(job["text"], language_id=job.get("lang", "pt"), exaggeration=job.get("exaggeration", 0.5),
                         cfg_weight=job.get("cfg_weight", 0.5), temperature=job.get("temperature", 0.8))
    job["result"] = pcm_result(wav, m.sr)


def worker_loop() -> None:
    while True:
        _, _, jid = q.get()
        with jobs_lock:
            job = jobs.get(jid)
        if not job:
            continue
        job["status"] = "running"
        job["started"] = time.time()
        try:
            run_job(job)
            job["status"] = "done"
        except FileNotFoundError:
            job["status"] = "error"
            job["error"] = "voz não cadastrada neste servidor"
            job["code"] = "voice_missing"
        except Exception as e:  # noqa: BLE001
            job["status"] = "error"
            job["error"] = str(e)[:300]
        job["finished"] = time.time()


def gc_jobs() -> None:
    while True:
        time.sleep(30)
        now = time.time()
        with jobs_lock:
            for k in [k for k, j in jobs.items() if now - j["created"] > JOB_TTL]:
                jobs.pop(k, None)


threading.Thread(target=worker_loop, daemon=True).start()
threading.Thread(target=gc_jobs, daemon=True).start()
if os.environ.get("VOICE_PRELOAD", "1") == "1":
    threading.Thread(target=lambda: (ov(), os.environ.get("VOICE_QUALITY", "1") == "1" and model()), daemon=True).start()


def enqueue(job: dict, front: bool = False) -> str:
    if q.qsize() >= MAX_QUEUE:
        raise HTTPException(429, "fila cheia")
    jid = uuid.uuid4().hex
    job.update({"id": jid, "status": "queued", "created": time.time()})
    with jobs_lock:
        jobs[jid] = job
    q.put((0 if front else 1, time.time(), jid))
    return jid


# ---------------- rotas ----------------
@app.get("/healthz")
def healthz():
    return {"ok": True, "ready": _ov is not None, "quality_ready": _model is not None, "queue": q.qsize(), "error": _model_error}


@app.post("/v1/voices/{vid}")
async def register(vid: str, request: Request):
    if not ID_RE.match(vid):
        raise HTTPException(400, "id inválido")
    body = await request.json()
    audio = base64.b64decode(body.get("audio_b64", ""))
    if not audio or len(audio) > 15 * 1024 * 1024:
        raise HTTPException(400, "amostra vazia ou grande demais")
    wav = to_wav24k(audio)
    del audio
    jid = enqueue({"kind": "register", "voice_id": vid, "wav": wav})
    return {"job_id": jid}


@app.delete("/v1/voices/{vid}")
def delete_voice(vid: str):
    if not ID_RE.match(vid):
        raise HTTPException(400, "id inválido")
    existed = False
    for kind in ("cb", "ov"):
        try:
            os.remove(voice_path(vid, kind))
            existed = True
        except FileNotFoundError:
            pass
    return {"ok": True, "existed": existed}


@app.get("/v1/voices/{vid}")
def has_voice(vid: str):
    if not ID_RE.match(vid):
        raise HTTPException(400, "id inválido")
    return {"exists": os.path.exists(voice_path(vid, "ov"))}


@app.post("/v1/tts")
async def tts(request: Request):
    body = await request.json()
    vid = str(body.get("voice_id", ""))
    text = str(body.get("text", "")).strip()
    if not ID_RE.match(vid) or not text:
        raise HTTPException(400, "pedido inválido")
    if len(text) > MAX_TEXT:
        raise HTTPException(400, "texto longo demais")
    if not os.path.exists(voice_path(vid)):
        return JSONResponse({"error": "voz não cadastrada neste servidor", "code": "voice_missing"}, status_code=404)
    if os.environ.get("VOICE_QUALITY", "1") != "1":
        raise HTTPException(400, "modo qualidade desligado neste servidor")
    jid = enqueue({"kind": "tts", "voice_id": vid, "text": text, "lang": "pt",
                   "exaggeration": float(body.get("exaggeration", 0.5)), "cfg_weight": float(body.get("cfg_weight", 0.5))})
    return {"job_id": jid, "position": q.qsize()}


@app.post("/v1/convert")
async def convert(request: Request):
    """Modo rápido: troca o timbre de um áudio-base (qualquer formato) pela voz clonada."""
    body = await request.json()
    vid = str(body.get("voice_id", ""))
    if not ID_RE.match(vid):
        raise HTTPException(400, "pedido inválido")
    if not os.path.exists(voice_path(vid, "ov")):
        return JSONResponse({"error": "voz não cadastrada neste servidor", "code": "voice_missing"}, status_code=404)
    audio = base64.b64decode(body.get("audio_b64", ""))
    if not audio or len(audio) > 5 * 1024 * 1024:
        raise HTTPException(400, "áudio-base vazio ou grande demais")
    wav = to_wav24k(audio, trim=False)
    base_key = re.sub(r"[^A-Za-z0-9_-]", "", str(body.get("base_key", "")))[:40]
    jid = enqueue({"kind": "convert", "voice_id": vid, "wav": wav, "base_key": base_key, "tau": min(1.0, max(0.1, float(body.get("tau", 0.3))))}, front=True)
    return {"job_id": jid, "position": q.qsize()}


@app.get("/v1/jobs/{jid}")
def job_status(jid: str):
    with jobs_lock:
        job = jobs.get(jid)
    if not job:
        raise HTTPException(404, "pedido não encontrado ou expirado")
    out = {"status": job["status"]}
    if job["status"] == "done":
        out.update(job.get("result", {}))
        with jobs_lock:
            jobs.pop(jid, None)  # entregue uma vez; nada fica guardado
    elif job["status"] == "error":
        out.update({"error": job.get("error"), "code": job.get("code")})
    return out
